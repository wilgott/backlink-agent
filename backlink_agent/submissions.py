"""Submission orchestration: filter -> allowlist -> state skip -> run -> record."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from backlink_agent import allowlist
from backlink_agent.adapters.runner import AdapterResult, run_adapter
from backlink_agent.config import Product, Settings
from backlink_agent.directories import Site
from backlink_agent.state import StateStore

SKIP_STATUSES = ("BLOCKED_BY_ALLOWLIST", "SKIPPED_ALREADY_DONE")


@dataclass
class SiteOutcome:
    site_name: str
    status: str
    reason: str = ""
    adapter_result: Optional[AdapterResult] = field(default=None, repr=False)


def plan_sites(
    sites: list[Site],
    settings: Settings,
    product: Product,
    min_score: Optional[int] = None,
) -> list[tuple[Site, allowlist.AllowlistResult]]:
    """Evaluate every site against the allowlist (used by the plan command).

    ``min_score`` temporarily overrides ``min_automation_score``.
    """
    if min_score is not None:
        settings = settings.model_copy(deep=True)
        settings.allowlist.min_automation_score = min_score
    return [(site, allowlist.check(site, settings, product)) for site in sites]


def run_submissions(
    sites: list[Site],
    settings: Settings,
    product: Product,
    repo_root: str | Path,
    state: StateStore,
    limit: Optional[int] = None,
    dry_run: bool = False,
    force: bool = False,
) -> list[SiteOutcome]:
    """Run adapters for allowed sites and record outcomes in the state DB.

    Processing order: allowlist filter -> state skip -> adapter run -> record.
    At most ``min(limit, max_submissions_per_run)`` adapters are executed;
    every evaluated site still gets a SiteOutcome so the CLI can print a full
    summary. Returns the per-site outcomes.
    """
    budget = settings.allowlist.max_submissions_per_run
    if limit is not None:
        budget = min(budget, limit)

    outcomes: list[SiteOutcome] = []
    attempted = 0
    for site in sites:
        decision = allowlist.check(site, settings, product)
        if not decision.allowed:
            outcomes.append(
                SiteOutcome(site.name, "BLOCKED_BY_ALLOWLIST", decision.reason)
            )
            continue
        if state.should_skip(site.name, force=force):
            outcomes.append(
                SiteOutcome(site.name, "SKIPPED_ALREADY_DONE", "already submitted (use --force to retry)")
            )
            continue
        if attempted >= budget:
            outcomes.append(
                SiteOutcome(site.name, "SKIPPED_BUDGET", f"run budget ({budget}) exhausted")
            )
            continue

        attempted += 1
        result = run_adapter(site, product, settings, repo_root, dry_run=dry_run)
        status = result.status
        if dry_run:
            # Never touch the state DB in dry-run mode.
            outcomes.append(SiteOutcome(site.name, status, result.reason, result))
            continue
        state.upsert(
            site.name,
            status,
            outcome=result.to_dict(),
            confirmation_text=result.confirmation_text,
            submitted_url=site.target_url if status == "SUBMITTED" else None,
            increment_retry=status in ("BLOCKED", "ERROR"),
        )
        outcomes.append(SiteOutcome(site.name, status, result.reason, result))
    return outcomes


def summarize(outcomes: list[SiteOutcome]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for o in outcomes:
        counts[o.status] = counts.get(o.status, 0) + 1
    return counts
