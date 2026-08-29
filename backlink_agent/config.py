"""Load and validate ``settings.json`` and ``product.json``.

Both files are validated with Pydantic v2 models configured with
``extra='forbid'`` so unknown keys fail fast — a typo in an allowlist
field must never silently widen the agent's permissions.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, field_validator

CONFIG_VERSION = 1


class Allowlist(BaseModel):
    """Hard limits on what the agent may do without human approval."""

    model_config = ConfigDict(extra="forbid")

    max_submissions_per_run: int = 10
    min_automation_score: int = 0
    allowed_sites: list[str] = []
    blocked_sites: list[str] = []
    allowed_costs: Literal["free_only", "free_and_paid_up_to_x", "any"] = "free_only"
    max_paid_usd: float = 0.0
    allowed_actions: list[str] = []
    allowed_personal_data: list[str] = []
    # Optional UTC hour window, e.g. "08-20". None = no restriction.
    allowed_hours_utc: Optional[str] = None

    @field_validator("allowed_hours_utc")
    @classmethod
    def _validate_hours(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        if not re.fullmatch(r"(\d{1,2})-(\d{1,2})", v):
            raise ValueError("allowed_hours_utc must look like 'HH-HH', e.g. '08-20'")
        start, end = (int(x) for x in v.split("-"))
        if not (0 <= start <= 23 and 0 <= end <= 23):
            raise ValueError("allowed_hours_utc hours must be in 0-23")
        return v


class EmailSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool = True
    provider: Literal["gmail", "resend"] = "gmail"
    poll_interval_seconds: int = 30
    max_wait_minutes: int = 30
    allowed_sender_patterns: list[str] = [".*"]
    # Resend-specific settings
    resend_api_key: Optional[str] = None
    resend_domain: Optional[str] = None


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: int = CONFIG_VERSION
    product_profile_path: str = "product.json"
    state_db: str = "./state/backlink-agent.db"
    log_dir: str = "./logs"
    token_dir: str = "~/.config/backlink-agent"
    allowlist: Allowlist  # required — never silently default to an empty policy
    email: EmailSettings = EmailSettings()


class ProductInfo(BaseModel):
    """Public product data handed to adapters. Most fields optional so a
    minimal profile is valid; adapters must cope with missing values."""

    model_config = ConfigDict(extra="forbid")

    name: str
    website: str
    tagline: dict[str, str] = {}
    description: dict[str, str] = {}
    categories: list[str] = []
    tags: list[str] = []
    founded_year: Optional[int] = None
    hq: Optional[str] = None
    team_size: Optional[str] = None
    pricing_model: Optional[str] = None
    founder_name: Optional[str] = None
    founder_linkedin: Optional[str] = None
    founder_github: Optional[str] = None
    contact_email_consumer: Optional[str] = None
    contact_email_business: Optional[str] = None
    phone: Optional[str] = None


class Assets(BaseModel):
    model_config = ConfigDict(extra="forbid")

    logo_512: Optional[str] = None
    screenshots: list[str] = []
    notes: Optional[str] = None  # free-form hint text in template files


class ElevatorAnswers(BaseModel):
    model_config = ConfigDict(extra="forbid")

    problem: Optional[str] = None
    audience: Optional[str] = None
    differentiator: Optional[str] = None


class Product(BaseModel):
    model_config = ConfigDict(extra="forbid")

    product: ProductInfo
    assets: Assets = Assets()
    elevator_answers: ElevatorAnswers = ElevatorAnswers()


def _load_json(path: Path) -> dict:
    if not path.is_file():
        raise FileNotFoundError(f"Config file not found: {path}")
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)


def load_settings(path: str | Path) -> Settings:
    """Load and validate settings.json. Raises ValidationError on bad input."""
    return Settings.model_validate(_load_json(Path(path)))


def load_product(path: str | Path) -> Product:
    """Load and validate product.json. Raises ValidationError on bad input."""
    return Product.model_validate(_load_json(Path(path)))


def resolve_product_path(settings: Settings, settings_path: str | Path) -> Path:
    """Resolve ``product_profile_path`` relative to the settings file's dir."""
    p = Path(settings.product_profile_path).expanduser()
    if p.is_absolute():
        return p
    return Path(settings_path).resolve().parent / p


def resolve_repo_path(settings: Settings, settings_path: str | Path, value: str) -> Path:
    """Resolve a repo-relative path from settings (state_db, log_dir) against
    the directory containing the settings file (the 'repo root')."""
    p = Path(value).expanduser()
    if p.is_absolute():
        return p
    return Path(settings_path).resolve().parent / p
