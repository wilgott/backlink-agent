"""Tests for backlink_agent.state: SQLite idempotency store."""

import pytest

from backlink_agent.state import StateStore


@pytest.fixture()
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


def record(**overrides):
    rec = {
        "site_name": "Launching Next",
        "status": "SUBMITTED",
        "last_attempt_at": "2026-07-29T08:15:00Z",
        "outcome_json": "{}",
        "retry_count": 0,
        "confirmation_text": "Thanks for submitting",
        "submitted_url": "https://example.com/listing",
    }
    rec.update(overrides)
    return rec


class TestUpsertAndGet:
    def test_get_missing_site_returns_none(self, store):
        assert store.get("No Such Site") is None

    def test_upsert_then_get_roundtrip(self, store):
        store.upsert(record())
        row = store.get("Launching Next")
        assert row is not None
        assert row["site_name"] == "Launching Next"
        assert row["status"] == "SUBMITTED"
        assert row["confirmation_text"] == "Thanks for submitting"

    def test_upsert_updates_existing_row(self, store):
        store.upsert(record(status="ERROR", confirmation_text=""))
        store.upsert(record(status="SUBMITTED"))
        row = store.get("Launching Next")
        assert row["status"] == "SUBMITTED"
        assert row["confirmation_text"] == "Thanks for submitting"

    def test_upsert_accepts_status_keyword(self, store):
        store.upsert("Startup Stash", status="NEEDS_EMAIL_VERIFICATION")
        row = store.get("Startup Stash")
        assert row["status"] == "NEEDS_EMAIL_VERIFICATION"


class TestShouldSkip:
    @pytest.mark.parametrize("status", ["SUBMITTED", "ALREADY_SUBMITTED"])
    def test_terminal_statuses_are_skipped(self, store, status):
        store.upsert(record(status=status))
        assert store.should_skip("Launching Next") is True

    @pytest.mark.parametrize(
        "status",
        ["BLOCKED", "ERROR", "NEEDS_EMAIL_VERIFICATION", "NEEDS_PAYMENT", "NO_ADAPTER"],
    )
    def test_non_terminal_statuses_are_not_skipped(self, store, status):
        store.upsert(record(status=status))
        assert store.should_skip("Launching Next") is False

    def test_unknown_site_is_not_skipped(self, store):
        assert store.should_skip("Never Seen Before") is False

    def test_force_overrides_skip(self, store):
        store.upsert(record(status="SUBMITTED"))
        assert store.should_skip("Launching Next", force=True) is False


class TestPendingEmailVerification:
    def test_empty_when_nothing_pending(self, store):
        store.upsert(record(status="SUBMITTED"))
        assert store.pending_email_verification() == []

    def test_returns_pending_sites(self, store):
        store.upsert(record(site_name="Startup Stash", status="NEEDS_EMAIL_VERIFICATION"))
        store.upsert(record(site_name="Launching Next", status="SUBMITTED"))
        store.upsert(record(site_name="Broken Site", status="ERROR"))

        pending = store.pending_email_verification()

        names = {
            (p["site_name"] if isinstance(p, dict) else p.site_name) for p in pending
        }
        assert names == {"Startup Stash"}

    def test_cleared_when_status_changes(self, store):
        store.upsert(record(status="NEEDS_EMAIL_VERIFICATION"))
        store.upsert(record(status="SUBMITTED"))
        assert store.pending_email_verification() == []
