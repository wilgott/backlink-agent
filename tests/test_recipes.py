"""Tests for data/recipes.json: per-site execution recipes."""

import csv
import json
import pathlib

from backlink_agent.adapters.runner import slugify

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
RECIPES = REPO_ROOT / "data" / "recipes.json"
CSV_PATH = REPO_ROOT / "data" / "directory-database.csv"

REQUIRED_KEYS = {"auth", "form_engine", "captcha", "adapter", "proven", "patterns", "notes"}
PROVEN_VALUES = {"submitted", "verified", "live_listing", "account_created", "form_mapped", "blocked"}
ADAPTER_SLUGS = {"aitoolslist", "launching-next", "startup-stash", "openhunts", "f6s", "devhunt"}


def _recipes():
    return json.loads(RECIPES.read_text(encoding="utf-8"))


def _csv_names():
    with CSV_PATH.open(newline="", encoding="utf-8") as fh:
        return {row["name"] for row in csv.DictReader(fh)}


def test_recipes_exist_and_cover_executed_sites():
    recipes = _recipes()
    assert len(recipes) >= 25


def test_every_recipe_names_a_csv_site():
    names = _csv_names()
    for site_name in _recipes():
        assert site_name in names, f"recipe for unknown site: {site_name}"


def test_recipe_schema():
    for site_name, recipe in _recipes().items():
        missing = REQUIRED_KEYS - recipe.keys()
        assert not missing, f"{site_name}: missing keys {missing}"
        assert recipe["proven"] in PROVEN_VALUES, f"{site_name}: bad proven value"
        assert recipe["adapter"] is None or recipe["adapter"] in ADAPTER_SLUGS, (
            f"{site_name}: unknown adapter slug {recipe['adapter']!r}"
        )
        assert isinstance(recipe["patterns"], list)
        for pid in recipe["patterns"]:
            assert isinstance(pid, int) and 1 <= pid <= 35, f"{site_name}: bad pattern id {pid}"


def test_sites_with_adapters_have_recipes():
    """Every site shipping an adapter must have a recipe entry pointing at it."""
    recipes = _recipes()
    slug_to_name = {slugify(name): name for name in _csv_names()}
    for slug in ADAPTER_SLUGS:
        assert slug in slug_to_name, f"adapter slug {slug} maps to no CSV site"
        name = slug_to_name[slug]
        assert name in recipes, f"{name} ships an adapter but has no recipe"
        assert recipes[name]["adapter"] == slug, f"{name}: recipe.adapter mismatch"
