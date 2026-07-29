"""SQLite idempotency store for submission state.

One row per site, keyed by site name. Used to skip already-submitted sites,
retry failures, and track sites awaiting email verification.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

SCHEMA = """
CREATE TABLE IF NOT EXISTS submissions (
  site_name TEXT PRIMARY KEY,
  status TEXT,
  last_attempt_at TEXT,
  outcome_json TEXT,
  retry_count INTEGER DEFAULT 0,
  confirmation_text TEXT,
  submitted_url TEXT
);
"""

TERMINAL_STATUSES = ("SUBMITTED", "ALREADY_SUBMITTED")


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class StateStore:
    def __init__(self, db_path: str | Path):
        self.db_path = Path(db_path).expanduser()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self.db_path))
        self._conn.row_factory = sqlite3.Row
        self._conn.execute(SCHEMA)
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()

    def __enter__(self) -> "StateStore":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def get(self, site_name: str) -> Optional[dict[str, Any]]:
        row = self._conn.execute(
            "SELECT * FROM submissions WHERE site_name = ?", (site_name,)
        ).fetchone()
        if row is None:
            return None
        out = dict(row)
        if out.get("outcome_json"):
            try:
                out["outcome"] = json.loads(out["outcome_json"])
            except json.JSONDecodeError:
                out["outcome"] = None
        return out

    def upsert(
        self,
        site_name: str | dict[str, Any],
        status: Optional[str] = None,
        outcome: Optional[dict[str, Any]] = None,
        confirmation_text: Optional[str] = None,
        submitted_url: Optional[str] = None,
        increment_retry: bool = False,
    ) -> None:
        # Accept either (site_name, status, ...) or a full record dict.
        if isinstance(site_name, dict):
            rec = site_name
            site_name = rec["site_name"]
            status = status or rec.get("status")
            if outcome is None and rec.get("outcome_json"):
                try:
                    outcome = json.loads(rec["outcome_json"])
                except (TypeError, json.JSONDecodeError):
                    outcome = None
            confirmation_text = confirmation_text if confirmation_text is not None else rec.get("confirmation_text")
            submitted_url = submitted_url if submitted_url is not None else rec.get("submitted_url")
        if not status:
            raise ValueError("upsert requires a status")
        existing = self.get(site_name)
        retry_count = (existing["retry_count"] if existing else 0) + (
            1 if increment_retry else 0
        )
        self._conn.execute(
            """
            INSERT INTO submissions
              (site_name, status, last_attempt_at, outcome_json, retry_count,
               confirmation_text, submitted_url)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(site_name) DO UPDATE SET
              status = excluded.status,
              last_attempt_at = excluded.last_attempt_at,
              outcome_json = excluded.outcome_json,
              retry_count = excluded.retry_count,
              confirmation_text = excluded.confirmation_text,
              submitted_url = excluded.submitted_url
            """,
            (
                site_name,
                status,
                _utcnow(),
                json.dumps(outcome) if outcome is not None else None,
                retry_count,
                confirmation_text,
                submitted_url,
            ),
        )
        self._conn.commit()

    def should_skip(self, site_name: str, force: bool = False) -> bool:
        """True when the site already reached a terminal status."""
        if force:
            return False
        rec = self.get(site_name)
        return bool(rec and rec.get("status") in TERMINAL_STATUSES)

    def pending_email_verification(self) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT * FROM submissions WHERE status = 'NEEDS_EMAIL_VERIFICATION'"
        ).fetchall()
        return [dict(r) for r in rows]

    def counts(self) -> dict[str, int]:
        rows = self._conn.execute(
            "SELECT status, COUNT(*) AS n FROM submissions GROUP BY status ORDER BY n DESC"
        ).fetchall()
        return {r["status"]: r["n"] for r in rows}
