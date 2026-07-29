"""Shared fixtures and helpers for the backlink-agent test suite."""

import json
import pathlib

import pytest

FIXTURES_DIR = pathlib.Path(__file__).parent / "fixtures"
REPO_ROOT = pathlib.Path(__file__).parent.parent
DATA_DIR = REPO_ROOT / "data"


@pytest.fixture()
def settings_path() -> pathlib.Path:
    return FIXTURES_DIR / "settings.json"


@pytest.fixture()
def product_path() -> pathlib.Path:
    return FIXTURES_DIR / "product.json"


@pytest.fixture()
def settings(settings_path):
    from backlink_agent import config

    return config.load_settings(settings_path)


@pytest.fixture()
def product(product_path):
    from backlink_agent import config

    return config.load_product(product_path)


def write_json(tmp_path, name, data):
    path = tmp_path / name
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


def load_fixture_dict(name):
    return json.loads((FIXTURES_DIR / name).read_text(encoding="utf-8"))
