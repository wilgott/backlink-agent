"""Load the seed directory database.

Reads ``data/directory-database.csv`` (the curated directory list) and
optionally merges ``data/qualified-sites.json`` (per-site metadata keyed by
name, currently supplying ``submission_url``).
"""
from __future__ import annotations

import csv
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


@dataclass
class Site:
    """One row of the directory database."""

    name: str
    url: str
    category: str = ""
    dr_estimate: str = ""
    link_type: str = ""
    submission_method: str = ""
    cost: str = ""
    requires_login: str = ""
    captcha: str = ""
    review_time: str = ""
    requirements: str = ""
    automation_score: int = 0
    automation_notes: str = ""
    status: str = ""
    submission_url: Optional[str] = None  # from qualified-sites.json, else url

    extra: dict = field(default_factory=dict)

    @property
    def target_url(self) -> str:
        """URL an adapter should drive to."""
        return self.submission_url or self.url


def _to_int(value: str) -> int:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return 0


def load_qualified(path: str | Path) -> dict[str, dict]:
    """Load qualified-sites.json keyed by site name.

    Accepts either a JSON object mapping name -> metadata, or a JSON list of
    objects each carrying a ``name`` key. Missing file -> empty dict.
    """
    p = Path(path)
    if not p.is_file():
        return {}
    data = json.loads(p.read_text(encoding="utf-8"))
    if isinstance(data, dict):
        return {str(k): (v if isinstance(v, dict) else {}) for k, v in data.items()}
    out: dict[str, dict] = {}
    for item in data:
        if isinstance(item, dict) and item.get("name"):
            out[str(item["name"])] = item
    return out


def load_sites(
    csv_path: str | Path,
    qualified_path: str | Path | None = None,
    live_only: bool = True,
) -> list[Site]:
    """Load sites from the CSV, optionally merged with qualified-sites.json.

    ``csv_path`` may be a data *directory* — then it is expanded to
    ``<dir>/directory-database.csv`` and ``<dir>/qualified-sites.json`` (when
    present and ``qualified_path`` is not given).

    Only rows with ``status == 'live'`` are returned unless ``live_only`` is
    False. ``automation_score`` is normalized to int (unparseable -> 0).
    """
    csv_path = Path(csv_path)
    if csv_path.is_dir():
        data_dir = csv_path
        csv_path = data_dir / "directory-database.csv"
        if qualified_path is None:
            candidate = data_dir / "qualified-sites.json"
            qualified_path = candidate if candidate.exists() else None

    qualified: dict[str, dict] = {}
    if qualified_path is not None:
        qualified = load_qualified(qualified_path)

    sites: list[Site] = []
    with Path(csv_path).open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            status = (row.get("status") or "").strip()
            if live_only and status.lower() != "live":
                continue
            name = (row.get("name") or "").strip()
            if not name:
                continue
            meta = qualified.get(name, {})
            sites.append(
                Site(
                    name=name,
                    url=(row.get("url") or "").strip(),
                    category=(row.get("category") or "").strip(),
                    dr_estimate=(row.get("dr_estimate") or "").strip(),
                    link_type=(row.get("link_type") or "").strip(),
                    submission_method=(row.get("submission_method") or "").strip(),
                    cost=(row.get("cost") or "").strip(),
                    requires_login=(row.get("requires_login") or "").strip(),
                    captcha=(row.get("captcha") or "").strip(),
                    review_time=(row.get("review_time") or "").strip(),
                    requirements=(row.get("requirements") or "").strip(),
                    automation_score=_to_int(row.get("automation_score") or "0"),
                    automation_notes=(row.get("automation_notes") or "").strip(),
                    status=status,
                    submission_url=(meta.get("submission_url") or "").strip() or None,
                )
            )
    return sites
