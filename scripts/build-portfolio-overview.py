#!/usr/bin/env python3
"""Build the human-readable portfolio backlink overview from data/portfolio.json."""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "data" / "portfolio.json"
OUTPUT_PATH = ROOT / "docs" / "PORTFOLIO.md"

STATUS_LABELS = {
    "confirmed": "confirmed live",
    "submitted_pending": "submitted / pending",
    "queued": "queued / not live yet",
    "prepared_blocked": "prepared / blocked",
    "skipped_paid": "skipped / paid-only",
    "not_started": "not registered yet",
}


def load_data() -> dict:
    with DATA_PATH.open(encoding="utf-8") as handle:
        return json.load(handle)


def build_markdown(data: dict) -> str:
    products = {item["id"]: item for item in data["products"]}
    directories = {item["id"]: item for item in data["directories"]}
    records = {(item["product_id"], item["directory_id"]): item for item in data["records"]}

    lines = [
        "# Portfolio backlink overview",
        "",
        f"Last reconciled: {data['last_reconciled']}",
        "",
        "This is the portfolio-level source of truth for backlink work. A directory is only counted as registered when its public listing has been verified. Queued, submitted, blocked, and paid-only outcomes remain visible as outstanding work.",
        "",
        "Source pages: "
        f"[Wilgott ventures]({data['sources']['ventures_page']}) · "
        f"[NotaryHub]({data['sources']['notaryhub_homepage']})",
        "",
        "## Registered / verified backlinks",
        "",
    ]

    confirmed = [
        (product, directory, record)
        for (product_id, directory_id), record in records.items()
        if record["status"] == "confirmed"
        for product in [products[product_id]]
        for directory in [directories[directory_id]]
    ]
    if confirmed:
        lines.append("| Product | Directory | Public listing | Last checked |")
        lines.append("| --- | --- | --- | --- |")
        for product, directory, record in confirmed:
            listing = record.get("listing_url", directory["url"])
            lines.append(
                f"| {product['name']} | [{directory['name']}]({directory['url']}) | "
                f"[{listing}]({listing}) | {record.get('last_checked', '—')} |"
            )
    else:
        lines.append("No verified backlinks recorded yet.")

    lines.extend(["", "## Backlink work still outstanding", ""])
    for product_id, product in products.items():
        outstanding = []
        for directory_id, directory in directories.items():
            record = records.get((product_id, directory_id))
            status = record["status"] if record else "not_started"
            if status != "confirmed":
                outstanding.append((directory, status, record))

        lines.append(f"### {product['name']} — {product['website']}")
        lines.append("")
        lines.append(product["description"])
        lines.append("")
        lines.append("| Directory | Status | Notes |")
        lines.append("| --- | --- | --- |")
        for directory, status, record in outstanding:
            notes = (record or {}).get("notes", "")
            lines.append(
                f"| [{directory['name']}]({directory['url']}) | "
                f"{STATUS_LABELS[status]} | {notes or 'No submission recorded yet.'} |"
            )
        lines.append("")

    lines.extend(
        [
            "## Status definitions",
            "",
            "- **confirmed live** — public product/listing URL verified.",
            "- **submitted / pending** — submitted, but editorial/admin approval or publication is not confirmed.",
            "- **queued / not live yet** — accepted into a launch queue; no live backlink yet.",
            "- **prepared / blocked** — work reached a blocker and needs a later retry or user handoff.",
            "- **skipped / paid-only** — intentionally not submitted because the available path required payment.",
            "- **not registered yet** — no submission record exists for that product/directory pair.",
            "",
            "To update this overview, edit `data/portfolio.json` and run `python scripts/build-portfolio-overview.py`.",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> None:
    OUTPUT_PATH.write_text(build_markdown(load_data()), encoding="utf-8")
    print(f"wrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
