"""Tests for the self-contained HTML report generator."""

import json
import re

import pytest

from backlink_agent.directories import Site
from backlink_agent.report import build_rows, render_html, summarize, write_report
from backlink_agent.state import StateStore


def _sites() -> list[Site]:
    return [
        Site(
            name="Alpha Directory",
            url="https://alpha.example.com",
            category="startup_directory",
            dr_estimate="70+",
            link_type="dofollow",
            automation_score=5,
            automation_notes="Pure form POST.",
        ),
        Site(
            name="Beta List",
            url="https://beta.example.com",
            category="launch_platform",
            dr_estimate="50-70",
            link_type="dofollow",
            automation_score=3,
            automation_notes="Captcha checkpoint.",
        ),
        Site(
            name="Gamma Hub",
            url="https://gamma.example.com",
            category="saas_directory",
            dr_estimate="30-50",
            link_type="nofollow",
            automation_score=1,
            automation_notes="Payment required.",
        ),
    ]


@pytest.fixture()
def state_db(tmp_path):
    """A fixture state DB: one SUBMITTED, one BLOCKED, one site untouched."""
    db_path = tmp_path / "state.db"
    with StateStore(db_path) as state:
        state.upsert(
            "Alpha Directory",
            "SUBMITTED",
            outcome={"status": "SUBMITTED", "reason": "form posted"},
            confirmation_text="Thanks for submitting",
            submitted_url="https://alpha.example.com/submit",
        )
        state.upsert("Beta List", "BLOCKED", outcome={"status": "BLOCKED", "reason": "captcha"})
    return db_path


@pytest.fixture()
def state_records(state_db):
    with StateStore(state_db) as state:
        return {name: state.get(name) for name in ("Alpha Directory", "Beta List")}


def test_build_rows_joins_state(state_records):
    rows = build_rows(_sites(), state_records)
    assert len(rows) == 3
    by_name = {r["name"]: r for r in rows}
    assert by_name["Alpha Directory"]["status"] == "SUBMITTED"
    assert by_name["Alpha Directory"]["notes"] == "form posted"
    assert by_name["Beta List"]["status"] == "BLOCKED"
    assert by_name["Gamma Hub"]["status"] == "NOT_ATTEMPTED"
    assert by_name["Gamma Hub"]["last_attempt"] == ""


def test_summarize_counts(state_records):
    summary = summarize(build_rows(_sites(), state_records))
    assert summary == {
        "total": 3,
        "submitted": 1,
        "verified": 0,
        "pending": 1,
        "skipped": 0,
        "not_attempted": 1,
    }


def test_render_html_contains_sites_and_statuses(state_records):
    html = render_html(build_rows(_sites(), state_records))
    for name in ("Alpha Directory", "Beta List", "Gamma Hub"):
        assert name in html
    # status vocabulary shows up in the embedded status metadata
    for status in ("SUBMITTED", "BLOCKED", "NOT_ATTEMPTED"):
        assert status in html
    # summary numbers are embedded in the JSON payload
    payload = re.search(
        r'<script id="report-data" type="application/json">(.*?)</script>', html, re.S
    ).group(1)
    data = json.loads(payload)
    assert data["summary"]["total"] == 3
    assert len(data["rows"]) == 3


def test_render_html_is_self_contained(state_records):
    html = render_html(build_rows(_sites(), state_records))
    assert html.startswith("<!DOCTYPE html>")
    # no external scripts, stylesheets, or CDN references
    assert 'src="http' not in html
    assert "src='http" not in html
    assert "<link" not in html
    assert "cdn" not in html.lower()
    assert "__DATA__" not in html  # template placeholder fully substituted


def test_render_html_escapes_script_closing_tags():
    sites = [Site(name="Evil </script><script>alert(1)</script>", url="https://x.example.com")]
    html = render_html(build_rows(sites, {}))
    payload = re.search(
        r'<script id="report-data" type="application/json">(.*?)</script>', html, re.S
    ).group(1)
    assert "</script" not in payload
    assert "<\\/script" in payload


def test_write_report_creates_file(state_db, tmp_path):
    out = tmp_path / "nested" / "report.html"
    with StateStore(state_db) as state:
        written = write_report(_sites(), state, out)
    assert written == out
    assert out.is_file()
    assert "Alpha Directory" in out.read_text(encoding="utf-8")
