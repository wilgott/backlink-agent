"""Tests for backlink_agent.config: settings.json and product.json loading."""

import pytest

from backlink_agent import config

from .conftest import load_fixture_dict, write_json


class TestLoadSettings:
    def test_valid_settings_load(self, settings_path):
        settings = config.load_settings(settings_path)
        assert settings is not None
        # Allowlist values are accessible and match the fixture.
        allowlist = (
            settings.get("allowlist") if isinstance(settings, dict) else settings.allowlist
        )
        getter = allowlist.get if isinstance(allowlist, dict) else lambda k: getattr(allowlist, k)
        assert getter("max_submissions_per_run") == 10
        assert getter("min_automation_score") == 4
        assert "Launching Next" in getter("allowed_sites")

    def test_unknown_top_level_key_rejected(self, tmp_path, settings_path):
        data = load_fixture_dict("settings.json")
        data["not_a_real_setting"] = True
        path = write_json(tmp_path, "settings.json", data)
        with pytest.raises(Exception):
            config.load_settings(path)

    def test_unknown_allowlist_key_rejected(self, tmp_path):
        data = load_fixture_dict("settings.json")
        data["allowlist"]["stealth_mode"] = True
        path = write_json(tmp_path, "settings.json", data)
        with pytest.raises(Exception):
            config.load_settings(path)

    def test_missing_required_field_rejected(self, tmp_path):
        data = load_fixture_dict("settings.json")
        del data["allowlist"]
        path = write_json(tmp_path, "settings.json", data)
        with pytest.raises(Exception):
            config.load_settings(path)

    def test_missing_file_rejected(self, tmp_path):
        with pytest.raises(Exception):
            config.load_settings(tmp_path / "does-not-exist.json")

    def test_invalid_json_rejected(self, tmp_path):
        path = tmp_path / "settings.json"
        path.write_text("{not json", encoding="utf-8")
        with pytest.raises(Exception):
            config.load_settings(path)


class TestLoadProduct:
    def test_valid_product_loads(self, product_path):
        product = config.load_product(product_path)
        assert product is not None
        block = product.get("product") if isinstance(product, dict) else product.product
        getter = block.get if isinstance(block, dict) else lambda k: getattr(block, k)
        assert getter("name") == "Example Product"
        assert getter("website") == "https://example.com"

    def test_unknown_key_rejected(self, tmp_path):
        data = load_fixture_dict("product.json")
        data["product"]["secret_api_key"] = "nope"
        path = write_json(tmp_path, "product.json", data)
        with pytest.raises(Exception):
            config.load_product(path)

    def test_missing_required_field_rejected(self, tmp_path):
        data = load_fixture_dict("product.json")
        del data["product"]["name"]
        path = write_json(tmp_path, "product.json", data)
        with pytest.raises(Exception):
            config.load_product(path)

    def test_missing_file_rejected(self, tmp_path):
        with pytest.raises(Exception):
            config.load_product(tmp_path / "does-not-exist.json")
