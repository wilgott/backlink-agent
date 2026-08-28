"""Allowlist enforcement — the gate every site must pass before any action.

Fail-closed: any mismatch produces ``allowed=False`` with an explicit reason,
and an empty ``allowed_sites`` list blocks everything.

Requirement heuristics are derived from free-text site metadata
(``submission_method``, ``requires_login``, ``captcha``, ``requirements``,
``automation_notes``, ``cost``) — see ``derive_actions`` /
``derive_personal_data``.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from backlink_agent.config import Product, Settings
from backlink_agent.directories import Site

# Personal-data keys -> product.json fields that must hold a value.
_PERSONAL_DATA_SOURCES = {
    "name": lambda p: p.product.founder_name,
    "email": lambda p: p.product.contact_email_consumer or p.product.contact_email_business,
    "business_email": lambda p: p.product.contact_email_business,
    "phone": lambda p: p.product.phone,
}


@dataclass
class AllowlistResult:
    allowed: bool
    reason: str
    required_actions: list[str] = field(default_factory=list)
    required_personal_data: list[str] = field(default_factory=list)


def _text(site: Site) -> str:
    return " ".join(
        [
            site.submission_method,
            site.requires_login,
            site.captcha,
            site.requirements,
            site.automation_notes,
            site.cost,
        ]
    ).lower()


def parse_cost(cost_str: str) -> tuple[bool, Optional[float]]:
    """Parse a cost cell. Returns ``(is_free, max_price_usd)``.

    ``is_free`` is True when the text mentions a free tier/path.
    ``max_price_usd`` is the highest dollar amount found (range upper bounds
    count, e.g. "$15-30/week" -> 30.0), or None when no explicit price appears.
    """
    text = (cost_str or "").lower()
    is_free = "free" in text
    amounts = [float(m) for m in re.findall(r"\$(\d+(?:\.\d+)?)", text)]
    # Upper bounds of ranges whose lower bound carried the "$" ("$15-30").
    amounts += [
        float(m)
        for m in re.findall(r"\$\d+(?:\.\d+)?\s*[-–]\s*\$?(\d+(?:\.\d+)?)", text)
    ]
    return is_free, (max(amounts) if amounts else None)


def derive_actions(site: Site) -> list[str]:
    """Infer the actions a submission to this site requires.

    - any form/api submission -> ``form_post``
    - ``account_required`` method or login needed -> ``account_creation``
    - email OTP / verification email hints -> ``email_verification``
    - non-trivial captcha (not none/math/simple/unknown) -> ``captcha_solving``
    - paid-only cost -> ``payment``
    - logo/screenshot/image upload hints -> ``file_upload``
    - phone hints -> ``phone_verification``
    - oauth hints -> ``oauth``
    """
    actions: set[str] = set()
    text = _text(site)
    method = site.submission_method.lower()
    captcha = site.captcha.lower().strip()

    if any(k in method for k in ("form", "api", "email")) or "form" in text:
        actions.add("form_post")
    if "account" in method or site.requires_login.lower().startswith("yes"):
        actions.add("account_creation")
    if re.search(r"email (otp|verification|confirm)|verification email|\botp\b", text):
        actions.add("email_verification")
    if captcha and captcha not in ("none", "no") and "none" not in captcha:
        # "unknown" means the seed did not observe a challenge — do not
        # treat missing recon as captcha_solving (blocks otherwise-automatable sites).
        if "unknown" not in captcha and not re.search(r"math|simple|text", captcha):
            actions.add("captcha_solving")
    is_free, max_price = parse_cost(site.cost)
    if not is_free and max_price:
        actions.add("payment")
    if re.search(r"logo|screenshot|\bupload\b|image", text):
        actions.add("file_upload")
    if "phone" in text:
        actions.add("phone_verification")
    if "oauth" in text:
        actions.add("oauth")
    return sorted(actions)


def derive_personal_data(site: Site) -> list[str]:
    """Infer which personal-data fields a submission to this site exposes.

    - email mention -> ``email`` (``business_email`` when a domain/business
      address is demanded)
    - founder/name mention -> ``name``
    - phone mention -> ``phone``
    """
    data: set[str] = set()
    text = _text(site)
    if "email" in text or "e-mail" in text:
        data.add("email")
        if re.search(r"domain[- ]email|business email|work email|company email", text):
            data.add("business_email")
    if re.search(r"founder|your name|maker name|full name", text):
        data.add("name")
    if "phone" in text:
        data.add("phone")
    return sorted(data)


def _within_hours(window: Optional[str], now: Optional[datetime] = None) -> bool:
    if not window:
        return True
    start, end = (int(x) for x in window.split("-"))
    hour = (now or datetime.now(timezone.utc)).hour
    if start <= end:
        return start <= hour < end
    return hour >= start or hour < end  # window wraps midnight


def check(
    site: Site | dict,
    settings: Settings | dict,
    product: Product | dict,
    now: Optional[datetime] = None,
) -> AllowlistResult:
    """Evaluate one site against the allowlist. First failure wins.

    Accepts either the validated config models or plain dicts shaped like
    settings.json / product.json / a CSV row — dicts are coerced to models.
    """
    if isinstance(settings, dict):
        settings = Settings(**settings)
    if isinstance(product, dict):
        product = Product(**product)
    if isinstance(site, dict):
        row = {f: site.get(f, "") for f in Site.__dataclass_fields__ if f != "submission_url"}
        try:
            row["automation_score"] = int(str(row.get("automation_score") or 0).strip())
        except ValueError:
            row["automation_score"] = 0
        site = Site(**row)
    al = settings.allowlist
    actions = derive_actions(site)
    personal = derive_personal_data(site)

    def blocked(reason: str) -> AllowlistResult:
        return AllowlistResult(False, reason, actions, personal)

    if site.name in al.blocked_sites:
        return blocked("site is in blocked_sites")
    if site.name not in al.allowed_sites:
        return blocked("site is not in allowed_sites")
    if site.automation_score < al.min_automation_score:
        return blocked(
            f"automation_score {site.automation_score} < min_automation_score {al.min_automation_score}"
        )
    if not _within_hours(al.allowed_hours_utc, now):
        return blocked(f"outside allowed_hours_utc window ({al.allowed_hours_utc})")

    is_free, max_price = parse_cost(site.cost)
    if al.allowed_costs == "free_only":
        # A free submission path must exist. Optional paid upgrades/featuring
        # are fine -- the allowlist permits spending $0, it does not demand
        # the site have no paid tier at all.
        if not is_free:
            return blocked(f"cost '{site.cost}' has no free submission path (free_only)")
    elif al.allowed_costs == "free_and_paid_up_to_x":
        # Paid path only matters when no free path exists.
        if not is_free:
            if max_price is None:
                return blocked(
                    f"cost '{site.cost}' has no free path and no parseable price"
                )
            if max_price > al.max_paid_usd:
                return blocked(
                    f"cost up to ${max_price:.0f} exceeds max_paid_usd ${al.max_paid_usd:.0f}"
                )

    extra_actions = [a for a in actions if a not in al.allowed_actions]
    if extra_actions:
        return blocked(f"requires actions not allowed: {', '.join(extra_actions)}")

    extra_data = [d for d in personal if d not in al.allowed_personal_data]
    if extra_data:
        return blocked(f"requires personal data not allowed: {', '.join(extra_data)}")
    for key in personal:
        source = _PERSONAL_DATA_SOURCES.get(key)
        if source is not None and not source(product):
            return blocked(f"product.json is missing a value for required personal data '{key}'")

    return AllowlistResult(True, "allowed", actions, personal)
