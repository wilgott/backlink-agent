"""Tests for backlink_agent.allowlist enforcement.

Every case is fail-closed: any mismatch must produce allowed=False with an
explicit, non-empty reason.
"""

import copy

import pytest

from backlink_agent import allowlist

from .conftest import load_fixture_dict


def make_settings(**allowlist_overrides):
    """A settings dict based on the fixture, with allowlist overrides."""
    settings = load_fixture_dict("settings.json")
    settings["allowlist"].update(allowlist_overrides)
    return settings


def make_product(**product_overrides):
    product = load_fixture_dict("product.json")
    product["product"].update(product_overrides)
    return product


def make_site(**overrides):
    """A directory row shaped like data/directory-database.csv."""
    site = {
        "name": "Launching Next",
        "url": "https://example.com/submit",
        "category": "launch_platform",
        "dr_estimate": "50 (est)",
        "link_type": "dofollow",
        "submission_method": "form",
        "cost": "free",
        "requires_login": "no",
        "captcha": "math",
        "review_time": "unknown",
        "requirements": "Product URL, tagline, description",
        "automation_score": 5,
        "automation_notes": "Public form, no login/payment.",
        "status": "live",
    }
    site.update(overrides)
    return site


def reason_text(result):
    return (result.reason or "").lower()


# --- blocked cases -----------------------------------------------------------


@pytest.mark.parametrize(
    "site_overrides, settings_overrides, product_overrides, case_id",
    [
        pytest.param(
            {"name": "Not Allowlisted Directory"},
            {},
            {},
            "site-not-in-allowed-sites",
        ),
        pytest.param(
            {"automation_score": 2},
            {},
            {},
            "automation-score-below-minimum",
        ),
        pytest.param(
            {"cost": "paid ($49 one-time review fee)"},
            {},
            {},
            "paid-site-under-free-only",
        ),
        pytest.param(
            {"requirements": "Product URL, tagline, phone number required"},
            {"allowed_personal_data": ["name", "email", "business_email"]},
            {},
            "phone-required-but-not-in-allowed-personal-data",
        ),
        pytest.param(
            {},
            {"blocked_sites": ["Launching Next"]},
            {},
            "site-in-blocked-sites",
        ),
        pytest.param(
            {"submission_method": "account_required", "requires_login": "yes (OAuth)"},
            {"allowed_actions": ["form_post"]},
            {},
            "required-action-not-allowed",
        ),
    ],
    ids=lambda v: v if isinstance(v, str) else None,
)
def test_blocked_cases(site_overrides, settings_overrides, product_overrides, case_id):
    settings = make_settings(**settings_overrides)
    product = make_product(**product_overrides)
    site = make_site(**site_overrides)

    result = allowlist.check(site, settings, product)

    assert result.allowed is False, f"{case_id}: expected blocked, got allowed"
    assert result.reason, f"{case_id}: blocked result must carry an explicit reason"


def test_phone_required_without_phone_value_in_product():
    """Phone allowed in principle, but product.json has no phone number."""
    settings = make_settings()  # phone IS in allowed_personal_data
    product = make_product(phone="")
    site = make_site(requirements="Product URL, tagline, phone number required")

    result = allowlist.check(site, settings, product)

    assert result.allowed is False
    assert result.reason


# --- happy path --------------------------------------------------------------


def test_happy_path_allowed_with_required_actions():
    settings = make_settings()
    product = make_product()
    site = make_site()  # free public form, score 5, no login

    result = allowlist.check(site, settings, product)

    assert result.allowed is True, f"expected allowed, got blocked: {result.reason}"
    required = set(result.required_actions)
    assert "form_post" in required
    # Every required action must be within the configured allowlist.
    assert required <= set(settings["allowlist"]["allowed_actions"])


# --- derive_actions captcha heuristic ---------------------------------------


def test_unknown_captcha_does_not_require_captcha_solving():
    """CSV captcha=unknown must not block sites that are otherwise allowed."""
    settings = make_settings()  # allowed_actions does not include captcha_solving
    product = make_product()
    for captcha in (
        "unknown",
        "unknown (form behind login)",
        "UNKNOWN",
        "unknown (likely present at signup)",
    ):
        result = allowlist.check(make_site(captcha=captcha), settings, product)
        assert "captcha_solving" not in result.required_actions, captcha
        assert result.allowed is True, f"{captcha}: {result.reason}"


def test_nontrivial_captcha_still_requires_captcha_solving():
    settings = make_settings()
    product = make_product()
    result = allowlist.check(make_site(captcha="reCAPTCHA v2"), settings, product)
    assert "captcha_solving" in result.required_actions
    assert result.allowed is False
    assert "captcha_solving" in result.reason


def test_math_captcha_does_not_require_captcha_solving():
    result = allowlist.check(make_site(captcha="math"), make_settings(), make_product())
    assert "captcha_solving" not in result.required_actions
    assert result.allowed is True
