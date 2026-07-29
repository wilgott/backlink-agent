"""Invoke Node.js per-site Playwright adapters (adapter contract v1).

Contract (see docs/ADAPTER_CONTRACT.md):

    node adapters/<site-slug>.js <input.json> <output.json>

``input.json`` carries run_id, site, flattened product, paths
(screenshot_dir, user_data_dir), headless and dry_run. The adapter writes
``output.json`` with a ``status`` of SUBMITTED / ALREADY_SUBMITTED /
NEEDS_EMAIL_VERIFICATION / NEEDS_PAYMENT / NEEDS_PHONE / NEEDS_OAUTH /
BLOCKED / ERROR plus reason, confirmation_text, links_found and artifacts.
"""
from __future__ import annotations

import json
import re
import subprocess
import tempfile
import uuid
from dataclasses import asdict, dataclass, field
from datetime import date
from pathlib import Path
from typing import Any, Optional

from backlink_agent.config import Product, Settings
from backlink_agent.directories import Site

ADAPTER_TIMEOUT_SECONDS = 600
VALID_STATUSES = {
    "SUBMITTED",
    "ALREADY_SUBMITTED",
    "NEEDS_EMAIL_VERIFICATION",
    "NEEDS_PAYMENT",
    "NEEDS_PHONE",
    "NEEDS_OAUTH",
    "BLOCKED",
    "ERROR",
    "NO_ADAPTER",  # set locally when the adapter file is missing
    "DRY_RUN",  # adapters may report this in dry-run mode
}

_TLDS = ("com", "io", "co", "net", "org", "ai", "dev", "app", "so", "sh")


def slugify(site_name: str) -> str:
    """'Launching Next' -> 'launching-next'; 'aitoolslist.io' -> 'aitoolslist'.

    A trailing common TLD is stripped so adapter filenames stay short.
    """
    name = site_name.strip().lower()
    parts = name.split(".")
    if len(parts) > 1 and parts[-1] in _TLDS:
        name = ".".join(parts[:-1])
    slug = re.sub(r"[^a-z0-9]+", "-", name).strip("-")
    return slug


@dataclass
class AdapterResult:
    """Parsed adapter outcome."""

    status: str
    reason: str = ""
    confirmation_text: Optional[str] = None
    submitted_at: Optional[str] = None
    email_verification: Optional[dict[str, Any]] = None
    requested_action: Optional[str] = None
    links_found: list[str] = field(default_factory=list)
    artifacts: dict[str, Any] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict)
    stdout: str = ""
    stderr: str = ""
    run_id: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def flatten_product(product: Product) -> dict[str, Any]:
    """Flatten the product profile per the adapter contract: scalar product
    fields plus ``tagline_<len>`` / ``description_<len>`` variants, logo and
    screenshots."""
    info = product.product
    out: dict[str, Any] = {
        "name": info.name,
        "website": info.website,
        "categories": info.categories,
        "tags": info.tags,
        "founded_year": info.founded_year,
        "hq": info.hq,
        "team_size": info.team_size,
        "pricing_model": info.pricing_model,
        "founder_name": info.founder_name,
        "founder_linkedin": info.founder_linkedin,
        "founder_github": info.founder_github,
        "contact_email_consumer": info.contact_email_consumer,
        "contact_email_business": info.contact_email_business,
        # Generic alias so adapters don't have to choose between the two.
        "contact_email": info.contact_email_business or info.contact_email_consumer,
        "phone": info.phone,
        "logo": product.assets.logo_512,
        "screenshots": product.assets.screenshots,
        "elevator_answers": {
            "problem": product.elevator_answers.problem,
            "audience": product.elevator_answers.audience,
            "differentiator": product.elevator_answers.differentiator,
        },
    }
    for length, text in info.tagline.items():
        out[f"tagline_{length}"] = text
    for length, text in info.description.items():
        out[f"description_{length}"] = text
    return out


def build_input(
    site: Site,
    product: Product,
    settings: Settings,
    repo_root: Path,
    dry_run: bool,
    run_id: Optional[str] = None,
) -> dict[str, Any]:
    """Build the input.json payload (adapter contract v1)."""
    run_id = run_id or str(uuid.uuid4())
    log_dir = Path(settings.log_dir).expanduser()
    if not log_dir.is_absolute():
        log_dir = repo_root / log_dir
    state_dir = repo_root / "state"
    return {
        "run_id": run_id,
        "site": asdict(site),
        "product": flatten_product(product),
        "paths": {
            "screenshot_dir": str(log_dir / date.today().isoformat()),
            "user_data_dir": str(state_dir / "profiles" / slugify(site.name)),
        },
        "headless": True,
        "dry_run": dry_run,
    }


def run_adapter(
    site: Site,
    product: Product,
    settings: Settings,
    repo_root: str | Path,
    dry_run: bool = False,
    timeout: int = ADAPTER_TIMEOUT_SECONDS,
) -> AdapterResult:
    """Run ``adapters/<slug>.js`` for one site and parse its output.json.

    Never raises for adapter-side failures; they surface as AdapterResult
    statuses: NO_ADAPTER (file missing), ERROR (timeout / bad JSON / non-zero
    exit without parseable output).
    """
    root = Path(repo_root)
    slug = slugify(site.name)
    adapter_path = root / "adapters" / f"{slug}.js"
    if not adapter_path.is_file():
        return AdapterResult(
            status="NO_ADAPTER",
            reason=f"no adapter at {adapter_path}",
        )

    run_id = str(uuid.uuid4())
    payload = build_input(site, product, settings, root, dry_run, run_id=run_id)

    with tempfile.TemporaryDirectory(prefix="backlink-agent-") as tmp:
        in_path = Path(tmp) / "input.json"
        out_path = Path(tmp) / "output.json"
        in_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

        try:
            proc = subprocess.run(
                ["node", str(adapter_path), str(in_path), str(out_path)],
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=str(root),
            )
        except subprocess.TimeoutExpired:
            return AdapterResult(
                status="ERROR",
                reason=f"adapter timed out after {timeout}s",
                run_id=run_id,
            )
        except FileNotFoundError:
            return AdapterResult(
                status="ERROR",
                reason="'node' executable not found on PATH",
                run_id=run_id,
            )

        stdout, stderr = proc.stdout or "", proc.stderr or ""
        if not out_path.is_file():
            return AdapterResult(
                status="ERROR",
                reason=(
                    f"adapter exited {proc.returncode} without writing output.json"
                ),
                stdout=stdout,
                stderr=stderr,
                run_id=run_id,
            )
        try:
            raw = json.loads(out_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            return AdapterResult(
                status="ERROR",
                reason=f"output.json is not valid JSON: {exc}",
                stdout=stdout,
                stderr=stderr,
                run_id=run_id,
            )

    status = str(raw.get("status", "ERROR"))
    if status not in VALID_STATUSES:
        status = "ERROR"
        raw.setdefault("reason", f"adapter returned unknown status {raw.get('status')!r}")
    return AdapterResult(
        status=status,
        reason=str(raw.get("reason", "")),
        confirmation_text=raw.get("confirmation_text"),
        submitted_at=raw.get("submitted_at"),
        email_verification=raw.get("email_verification"),
        requested_action=raw.get("requested_action"),
        links_found=list(raw.get("links_found") or []),
        artifacts=dict(raw.get("artifacts") or {}),
        raw=raw,
        stdout=stdout,
        stderr=stderr,
        run_id=run_id,
    )
