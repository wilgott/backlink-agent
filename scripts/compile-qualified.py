#!/usr/bin/env python3
"""Compile qualified-chunk-*.json files into data/qualified-sites.json.

The chunk files are produced by the (manual, out-of-scope) qualification
process and live outside this repository. This script merges all of them,
de-duplicates by site name (first occurrence wins), keeps all fields, and
writes a single keyed list to data/qualified-sites.json.

Usage:
    python scripts/compile-qualified.py --src-dir /path/to/.work \
        [--out data/qualified-sites.json]
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--src-dir",
        required=True,
        help="Directory containing qualified-chunk-*.json files.",
    )
    parser.add_argument(
        "--out",
        default=os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "data",
            "qualified-sites.json",
        ),
        help="Output path (default: <repo>/data/qualified-sites.json).",
    )
    args = parser.parse_args()

    pattern = os.path.join(args.src_dir, "qualified-chunk-*.json")
    chunk_files = sorted(glob.glob(pattern))
    if not chunk_files:
        print(f"error: no files matching {pattern}", file=sys.stderr)
        return 1

    seen: set[str] = set()
    sites: list[dict] = []
    duplicates: list[str] = []
    total = 0

    for path in chunk_files:
        with open(path, encoding="utf-8") as fh:
            entries = json.load(fh)
        if not isinstance(entries, list):
            print(f"error: {path} is not a JSON list", file=sys.stderr)
            return 1
        for entry in entries:
            total += 1
            name = entry.get("name")
            if not name:
                print(f"warning: entry without name in {path}; skipped", file=sys.stderr)
                continue
            if name in seen:
                duplicates.append(name)
                continue
            seen.add(name)
            sites.append(entry)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(sites, fh, indent=1, ensure_ascii=False)
        fh.write("\n")

    print(f"read {len(chunk_files)} chunk files, {total} entries")
    print(f"wrote {len(sites)} unique sites to {args.out}")
    if duplicates:
        print(f"skipped {len(duplicates)} duplicates: {', '.join(duplicates)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
