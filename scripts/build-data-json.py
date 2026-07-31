#!/usr/bin/env python3
"""Regenerate data/qualified-sites.json from data/directory-database.csv.

The CSV is the single source of truth; the JSON is a convenience rendering
for agents that prefer it. automation_score is emitted as an int.

Usage: python3 scripts/build-data-json.py
"""
import csv
import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = REPO_ROOT / "data" / "directory-database.csv"
OUT_PATH = REPO_ROOT / "data" / "qualified-sites.json"


def build_rows(csv_path=CSV_PATH):
    with Path(csv_path).open(newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    for row in rows:
        row["automation_score"] = int(row["automation_score"])
    return rows


def main():
    rows = build_rows()
    OUT_PATH.write_text(json.dumps(rows, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {len(rows)} sites to {OUT_PATH}")


if __name__ == "__main__":
    main()
