"""Guard: this is a PUBLIC repo — campaign internals must never come back."""

import pathlib

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
SCAN_SUFFIXES = {".py", ".js", ".md", ".json", ".csv", ".html", ".toml", ".txt"}
SKIP_DIRS = {".git", ".venv", "node_modules", "__pycache__", ".pytest_cache"}
FORBIDDEN = ["klinky", "/users/robin", ".work/", "credentials.md", "828753762", "gmail_body"]


def _files():
    for path in REPO_ROOT.rglob("*"):
        if not path.is_file() or path.suffix not in SCAN_SUFFIXES:
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if path.name == "test_no_leaks.py":
            continue  # this file defines the needles
        yield path


def test_no_campaign_internals_in_repo():
    offenders = []
    for path in _files():
        text = path.read_text(encoding="utf-8", errors="ignore").lower()
        for needle in FORBIDDEN:
            if needle in text:
                offenders.append(f"{path.relative_to(REPO_ROOT)}: contains {needle!r}")
    assert not offenders, "\n".join(offenders)
