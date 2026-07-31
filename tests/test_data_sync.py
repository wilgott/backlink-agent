"""data/qualified-sites.json must be a faithful JSON rendering of the CSV.

The CSV is the single source of truth; regenerate the JSON with
``python3 scripts/build-data-json.py`` after editing the CSV.
"""

import csv
import json
import pathlib

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent


def _csv_rows():
    with (REPO_ROOT / "data" / "directory-database.csv").open(newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def _json_rows():
    return json.loads((REPO_ROOT / "data" / "qualified-sites.json").read_text(encoding="utf-8"))


def test_same_sites_same_order():
    csv_names = [r["name"] for r in _csv_rows()]
    json_names = [r["name"] for r in _json_rows()]
    assert json_names == csv_names


def test_fields_match():
    for crow, jrow in zip(_csv_rows(), _json_rows()):
        for key, value in crow.items():
            assert key in jrow, f"{crow['name']}: {key} missing from JSON"
            assert str(jrow[key]) == value, (
                f"{crow['name']}: {key} differs (CSV {value!r} vs JSON {jrow[key]!r})"
            )
