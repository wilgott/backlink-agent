"""Tests for backlink_agent.directories: seed database loading."""

import pathlib

import pytest

from backlink_agent import directories

from .conftest import DATA_DIR


@pytest.fixture(scope="module")
def sites():
    return directories.load_sites(DATA_DIR, live_only=False)


def _get(site, key):
    return site[key] if isinstance(site, dict) else getattr(site, key)


def test_loads_seed_csv(sites):
    assert sites, "load_sites returned no sites"
    assert len(sites) >= 130


def test_automation_scores_are_ints_in_range(sites):
    for site in sites:
        score = _get(site, "automation_score")
        assert isinstance(score, int), f"{_get(site, 'name')}: score {score!r} not int"
        assert 1 <= score <= 5, f"{_get(site, 'name')}: score {score} out of range"


def test_all_sites_have_known_status(sites):
    """The seed DB now carries execution statuses (submitted/blocked/etc.)
    from the live campaign — assert every row has SOME non-empty status."""
    for site in sites:
        assert _get(site, "status"), (
            f"{_get(site, 'name')}: unexpected status {_get(site, 'status')!r}"
        )


def test_required_fields_present(sites):
    for site in sites:
        for field in ("name", "url", "cost", "submission_method"):
            value = _get(site, field)
            assert value, f"site missing {field}: {site!r}"


def test_names_are_unique(sites):
    names = [_get(site, "name") for site in sites]
    assert len(names) == len(set(names)), (
        f"duplicate names: {sorted({n for n in names if names.count(n) > 1})}"
    )


def test_missing_data_dir_raises(tmp_path):
    with pytest.raises(Exception):
        directories.load_sites(tmp_path / "no-such-dir")
