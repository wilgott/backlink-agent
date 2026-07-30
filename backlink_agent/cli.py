"""Command-line interface: init, auth, plan, submit, verify-emails, status,
adapter-test.

Agent-facing contract: run ``plan`` before ``submit``; the allowlist in
settings.json is the sole authority on what may run — the CLI never prompts
for per-site approval.
"""
from __future__ import annotations

import json
import re
import shutil
import time
from pathlib import Path
from typing import Optional

import click

from backlink_agent import __version__, directories, email as email_mod, report as report_mod
from backlink_agent.config import (
    Product,
    Settings,
    load_product,
    load_settings,
    resolve_product_path,
    resolve_repo_path,
)
from backlink_agent.state import StateStore
from backlink_agent.submissions import plan_sites, run_submissions, summarize
from backlink_agent.adapters.runner import run_adapter, slugify

_PACKAGE_ROOT = Path(__file__).resolve().parent.parent

_FALLBACK_SETTINGS = {
    "version": 1,
    "product_profile_path": "product.json",
    "state_db": "./state/backlink-agent.db",
    "log_dir": "./logs",
    "token_dir": "~/.config/backlink-agent",
    "allowlist": {
        "max_submissions_per_run": 10,
        "min_automation_score": 4,
        "allowed_sites": [],
        "blocked_sites": [],
        "allowed_costs": "free_only",
        "max_paid_usd": 0,
        "allowed_actions": [
            "form_post",
            "account_creation",
            "email_verification",
            "file_upload",
        ],
        "allowed_personal_data": ["name", "email", "business_email", "phone"],
        "allowed_hours_utc": None,
    },
    "email": {
        "enabled": True,
        "provider": "gmail",
        "poll_interval_seconds": 30,
        "max_wait_minutes": 30,
        "allowed_sender_patterns": [".*"],
    },
}

_FALLBACK_PRODUCT = {
    "product": {
        "name": "Your Product",
        "website": "https://example.com",
        "tagline": {"50": "A one-line description of your product"},
        "description": {"150": "A slightly longer description of your product."},
        "categories": [],
        "tags": [],
        "contact_email_consumer": "you@example.com",
    },
    "assets": {"logo_512": None, "screenshots": []},
    "elevator_answers": {"problem": None, "audience": None, "differentiator": None},
}


def _repo_root(settings_path: str) -> Path:
    return Path(settings_path).resolve().parent


def _load(settings_path: str) -> tuple[Settings, Product, Path]:
    """Load settings + product; returns (settings, product, repo_root)."""
    settings = load_settings(settings_path)
    product = load_product(resolve_product_path(settings, settings_path))
    return settings, product, _repo_root(settings_path)


def _load_sites(repo_root: Path):
    data = repo_root / "data"
    return directories.load_sites(data / "directory-database.csv", data / "qualified-sites.json")


def _parse_since(value: str) -> str:
    """Turn '30m'/'12h'/'7d' into a Gmail query. Sub-day windows use an
    ``after:<epoch>`` filter (Gmail's newer_than only supports d/m/y where m
    means months), day windows use ``newer_than:<n>d``."""
    m = re.fullmatch(r"(\d+)\s*([mhd])", value.strip().lower())
    if not m:
        raise click.BadParameter("expected a duration like '30m', '12h' or '7d'")
    amount, unit = int(m.group(1)), m.group(2)
    if unit == "d":
        return f"newer_than:{amount}d"
    seconds = amount * (60 if unit == "m" else 3600)
    return f"after:{int(time.time()) - seconds}"


@click.group(context_settings={"help_option_names": ["-h", "--help"]})
@click.version_option(__version__, prog_name="backlink-agent")
def main() -> None:
    """Allowlist-gated directory submission automation."""


@main.command()
@click.option("--dir", "target", default=".", help="Directory to scaffold into.")
def init(target: str) -> None:
    """Scaffold settings.json, product.json, state/ and logs/ into a directory.

    Copies the templates from examples/ when available, otherwise writes
    minimal built-in defaults.
    """
    dest = Path(target).resolve()
    dest.mkdir(parents=True, exist_ok=True)
    examples = _PACKAGE_ROOT / "examples"
    for name, fallback in (
        ("settings.json", _FALLBACK_SETTINGS),
        ("product.json", _FALLBACK_PRODUCT),
    ):
        out = dest / name
        if out.exists():
            click.echo(f"exists, skipping: {out}")
            continue
        src = examples / name
        if src.is_file():
            shutil.copyfile(src, out)
        else:
            out.write_text(json.dumps(fallback, indent=2) + "\n", encoding="utf-8")
        click.echo(f"wrote {out}")
    for sub in ("state", "logs"):
        (dest / sub).mkdir(exist_ok=True)
        click.echo(f"created {dest / sub}/")
    click.echo("\nNext: edit settings.json (allowlist) and product.json, then run:")
    click.echo("  backlink-agent --settings <dir>/settings.json plan")


@main.group()
def auth() -> None:
    """Authentication helpers."""


@auth.command("gmail")
def auth_gmail() -> None:
    """Run the Gmail OAuth flow (requires BACKLINK_AGENT_GMAIL_CLIENT_SECRET)."""
    email_mod.auth_flow()


@main.command()
@click.option("--settings", "settings_path", default="./settings.json",
              type=click.Path(exists=True, dir_okay=False))
@click.option("--limit", default=None, type=int, help="Max rows to print.")
@click.option("--min-score", default=None, type=int,
              help="Override allowlist min_automation_score.")
def plan(settings_path: str, limit: Optional[int], min_score: Optional[int]) -> None:
    """Show the allowlist decision for every site before submitting."""
    settings, product, root = _load(settings_path)
    rows = plan_sites(_load_sites(root), settings, product, min_score=min_score)
    if limit is not None:
        rows = rows[:limit]
    click.echo(f"{'SITE':<28} {'SCORE':>5}  {'DECISION':<8} REASON")
    click.echo("-" * 90)
    for site, decision in rows:
        verdict = "ALLOWED" if decision.allowed else "BLOCKED"
        click.echo(f"{site.name:<28} {site.automation_score:>5}  {verdict:<8} {decision.reason}")
    allowed = sum(1 for _, d in rows if d.allowed)
    click.echo("-" * 90)
    click.echo(f"{allowed} allowed / {len(rows)} evaluated")


@main.command()
@click.option("--settings", "settings_path", default="./settings.json",
              type=click.Path(exists=True, dir_okay=False))
@click.option("--limit", default=None, type=int, help="Max adapters to run.")
@click.option("--dry-run", is_flag=True, help="Fill forms but never submit; no state writes.")
@click.option("--force", is_flag=True, help="Re-run sites already marked submitted.")
def submit(settings_path: str, limit: Optional[int], dry_run: bool, force: bool) -> None:
    """Run adapters for all allowlisted sites (up to the run budget)."""
    settings, product, root = _load(settings_path)
    sites = _load_sites(root)
    db_path = resolve_repo_path(settings, settings_path, settings.state_db)
    with StateStore(db_path) as state:
        outcomes = run_submissions(
            sites, settings, product, root, state,
            limit=limit, dry_run=dry_run, force=force,
        )
    click.echo(f"{'SITE':<28} {'STATUS':<26} REASON")
    click.echo("-" * 90)
    for o in outcomes:
        click.echo(f"{o.site_name:<28} {o.status:<26} {o.reason}")
    click.echo("-" * 90)
    summary = summarize(outcomes)
    click.echo("summary: " + ", ".join(f"{k}={v}" for k, v in sorted(summary.items())))
    if dry_run:
        click.echo("(dry run: state DB was not modified)")


@main.command("verify-emails")
@click.option("--settings", "settings_path", default="./settings.json",
              type=click.Path(exists=True, dir_okay=False))
@click.option("--since", default="2d", help="Lookback window, e.g. '30m', '12h', '7d'.")
@click.option("--max", "max_results", default=20, type=int)
def verify_emails(settings_path: str, since: str, max_results: int) -> None:
    """Poll Gmail for verification links and OTP codes from allowed senders.

    MVP prints findings only; auto-click is a future feature gated behind an
    explicit allowlist action.
    """
    settings = load_settings(settings_path)
    if not settings.email.enabled:
        raise click.ClickException("email is disabled in settings.json")
    patterns = [re.compile(p, re.IGNORECASE) for p in settings.email.allowed_sender_patterns]
    query = _parse_since(since)
    messages = email_mod.read_messages(query, max_results=max_results)

    pending_sites: set[str] = set()
    db_path = resolve_repo_path(settings, settings_path, settings.state_db)
    if db_path.is_file():
        with StateStore(db_path) as state:
            pending_sites = {r["site_name"] for r in state.pending_email_verification()}
    if pending_sites:
        click.echo(f"pending email verification: {', '.join(sorted(pending_sites))}\n")

    shown = 0
    for msg in messages:
        if not any(p.search(msg["from"]) for p in patterns):
            continue
        shown += 1
        otps = email_mod.extract_otp(msg["subject"] + "\n" + msg["body"])
        click.echo(f"from:    {msg['from']}")
        click.echo(f"subject: {msg['subject']}")
        click.echo(f"date:    {msg['date']}")
        for link in msg["links"]:
            click.echo(f"  link: {link}")
        for otp in otps:
            click.echo(f"  otp:  {otp}")
        click.echo("")
    click.echo(f"{shown} matching message(s) since {since}")


@main.command()
@click.option("--settings", "settings_path", default="./settings.json",
              type=click.Path(exists=True, dir_okay=False))
def status(settings_path: str) -> None:
    """Print submission counts from the state DB."""
    settings = load_settings(settings_path)
    db_path = resolve_repo_path(settings, settings_path, settings.state_db)
    if not db_path.is_file():
        click.echo(f"no state DB yet at {db_path}")
        return
    with StateStore(db_path) as state:
        counts = state.counts()
        pending = state.pending_email_verification()
    if not counts:
        click.echo("state DB is empty")
        return
    for status_name, n in counts.items():
        click.echo(f"{status_name:<28} {n}")
    click.echo(f"{'TOTAL':<28} {sum(counts.values())}")
    if pending:
        click.echo("\npending email verification:")
        for row in pending:
            click.echo(f"  {row['site_name']} (last attempt {row['last_attempt_at']})")


@main.command()
@click.option("--settings", "settings_path", default="./settings.json",
              type=click.Path(exists=True, dir_okay=False))
@click.option("--out", "out_path", default=None, type=click.Path(dir_okay=False),
              help="Output file (default: <log_dir>/report.html).")
@click.option("--open", "open_browser", is_flag=True,
              help="Open the report after writing (macOS 'open').")
def report(settings_path: str, out_path: Optional[str], open_browser: bool) -> None:
    """Generate a self-contained HTML dashboard of submission state."""
    settings = load_settings(settings_path)
    root = _repo_root(settings_path)
    sites = _load_sites(root)
    db_path = resolve_repo_path(settings, settings_path, settings.state_db)
    records: dict = {}
    if db_path.is_file():
        with StateStore(db_path) as state:
            for site in sites:
                rec = state.get(site.name)
                if rec:
                    records[site.name] = rec
    if out_path is None:
        out = resolve_repo_path(settings, settings_path, settings.log_dir) / "report.html"
    else:
        out = Path(out_path)
    product_name = ""
    product_path = resolve_product_path(settings, settings_path)
    if product_path.is_file():
        product_name = load_product(product_path).product.name
    title = f"{product_name} — Backlink Report" if product_name else "Backlink Agent — Submission Report"
    written = report_mod.write_report(sites, records, out, title=title)
    click.echo(f"wrote {written}")
    if open_browser:
        import subprocess

        subprocess.run(["open", str(written)], check=False)


@main.command("adapter-test")
@click.option("--settings", "settings_path", default="./settings.json",
              type=click.Path(exists=True, dir_okay=False))
@click.option("--site", "site_name", required=True, help="Site name from the directory DB.")
@click.option("--dry-run", is_flag=True, help="Fill but never submit.")
def adapter_test(settings_path: str, site_name: str, dry_run: bool) -> None:
    """Run one site's adapter and print its raw output.json."""
    settings, product, root = _load(settings_path)
    sites = _load_sites(root)
    site = next((s for s in sites if s.name == site_name), None)
    if site is None:
        known = ", ".join(s.name for s in sites[:10])
        raise click.ClickException(
            f"site '{site_name}' not found in directory DB (first entries: {known}, ...)"
        )
    click.echo(f"adapter: adapters/{slugify(site.name)}.js (dry_run={dry_run})")
    result = run_adapter(site, product, settings, root, dry_run=dry_run)
    click.echo(json.dumps(result.raw or result.to_dict(), indent=2))
    if result.stderr:
        click.echo("\n--- adapter stderr ---", err=True)
        click.echo(result.stderr, err=True)


if __name__ == "__main__":
    main()
