#!/usr/bin/env python3
"""Reconcile the TinyLaunch catalog snapshot against the directory database.

TinyLaunch's submission service is a paid bundle, not a free-listing source of
truth. The snapshot is therefore kept as discovery evidence and its rows are
not automatically promoted into the qualified database.
"""

from __future__ import annotations

import csv
import json
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "data" / "tinylaunch-catalog.json"
DATABASE_PATH = ROOT / "data" / "directory-database.csv"
OUTPUT_PATH = ROOT / "docs" / "TINYLAUNCH-RECONCILIATION.md"


def normalise_domain(value: str) -> str:
    parsed = urlparse(value if "://" in value else f"https://{value}")
    domain = (parsed.hostname or "").lower().strip(".")
    return domain[4:] if domain.startswith("www.") else domain


def load_rows() -> tuple[dict, list[dict], list[dict]]:
    snapshot = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    with DATABASE_PATH.open(newline="", encoding="utf-8") as handle:
        database = list(csv.DictReader(handle))
    return snapshot, snapshot["sites"], database


def build_report(snapshot: dict, tiny_sites: list[dict], database: list[dict]) -> str:
    by_domain = {
        normalise_domain(row.get("url", "")): row
        for row in database
        if normalise_domain(row.get("url", ""))
    }
    by_name = {row.get("name", "").strip().lower(): row for row in database}

    overlaps: list[tuple[dict, dict]] = []
    new_candidates: list[dict] = []
    for site in tiny_sites:
        match = by_domain.get(normalise_domain(site["url"]))
        if match is None:
            match = by_name.get(site["name"].strip().lower())
        if match is None:
            new_candidates.append(site)
        else:
            overlaps.append((site, match))

    def dr(site: dict) -> float:
        try:
            return float(site.get("dr") or 0)
        except (TypeError, ValueError):
            return 0

    new_candidates.sort(key=lambda site: (-dr(site), site["name"].lower()))
    overlaps.sort(key=lambda item: (-dr(item[0]), item[0]["name"].lower()))

    lines = [
        "# TinyLaunch catalog reconciliation",
        "",
        f"Snapshot captured: {snapshot['captured_on']}",
        "",
        "TinyLaunch advertises a catalog of **{catalog_claim}** sites and a paid "
        "bundle of **{premium_claim}** selected sites. This snapshot contains "
        "{observed} rows exposed by the current page bundle; it is discovery "
        "evidence, not proof that every row is free, live, dofollow, or included "
        "in the paid bundle.".format(
            catalog_claim=snapshot["catalog_claim"],
            premium_claim=snapshot["premium_selection_claim"],
            observed=len(tiny_sites),
        ),
        "",
        "Matching uses normalised domains first, then exact lower-case names. "
        "The qualified database is intentionally not bulk-filled from this paid "
        "catalog; new candidates need an independent free-submission and quality check.",
        "",
        "## Reconciliation",
        "",
        "| Metric | Count |",
        "| --- | ---: |",
        f"| TinyLaunch rows observed | {len(tiny_sites)} |",
        f"| Already represented in backlink-agent | {len(overlaps)} |",
        f"| New candidate domains/names | {len(new_candidates)} |",
        "",
        f"The **{len(new_candidates)} new candidates** are not the same thing as "
        "TinyLaunch's claim of 110 premium placements; the number is a result of this snapshot's "
        "domain reconciliation and should not be treated as a verified bundle match.",
        "",
        "## Existing overlaps",
        "",
        "| TinyLaunch name | DR shown | TinyLaunch URL | Existing repo row |",
        "| --- | ---: | --- | --- |",
    ]
    for tiny, existing in overlaps:
        lines.append(
            f"| {tiny['name']} | {tiny.get('dr', '—')} | [{tiny['url']}]({tiny['url']}) | "
            f"{existing['name']} |"
        )

    lines.extend(
        [
            "",
            "## New candidates to qualify",
            "",
            "These are candidates for review, ordered by TinyLaunch's displayed "
            "DR estimate. They are not automatically approved for free submission.",
            "",
            "| Candidate | DR shown | Link type | Type | URL |",
            "| --- | ---: | --- | --- | --- |",
        ]
    )
    for site in new_candidates:
        lines.append(
            f"| {site['name']} | {site.get('dr', '—')} | {site.get('link_type', '—')} | "
            f"{site.get('type', '—')} | [{site['url']}]({site['url']}) |"
        )

    lines.extend(
        [
            "",
            "## Operating rule",
            "",
            "1. Use the overlap table to avoid paying TinyLaunch to resubmit sites already tracked here.",
            "2. Qualify new candidates independently: free listing path, relevant audience, "
            "public listing URL, and backlink/link-type evidence.",
            "3. Only then promote a candidate into `data/directory-database.csv` and regenerate "
            "`data/qualified-sites.json` with `python scripts/build-data-json.py`.",
            "",
            "The JSON snapshot is suitable for importing into a separate Notion database "
            "if a Notion connector is added later; until then, this repo remains the "
            "versioned source of truth.",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> None:
    snapshot, tiny_sites, database = load_rows()
    OUTPUT_PATH.write_text(build_report(snapshot, tiny_sites, database), encoding="utf-8")
    print(f"wrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
