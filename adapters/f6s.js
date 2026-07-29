// Adapter: F6S (https://f6s.com)
// Email/password signup + reCAPTCHA v2 + 6-digit email OTP, then a company
// profile that IS the listing. See docs/PATTERNS.md sections 15, 16, 18 —
// read them before modifying this file.
//
// OTP HANDOFF (design decision — the adapter never reads Gmail itself):
// after the Join form is accepted, F6S emails a 6-digit code. The adapter
// stops at the code screen and emits NEEDS_EMAIL_VERIFICATION with
// expected_sender_pattern 'f6s.com'. The campaign driver reads the code from
// the Gmail inbox (gmail_body.py / python -m backlink_agent verify-emails)
// and enters it — ONE assisted step in the same sitting (re-submitting the
// login form in the same profile re-sends the code). Once the profile is
// verified, every later run of this adapter skips signup and goes straight
// to company creation / profile editing unattended.
//
// Field notes (proven 2026-07-29, klinky.io campaign):
// - Correct entry point is /main/authorization/login — f6s.com/sign-up 400s.
// - reCAPTCHA v2 checkbox passed with ONE plain click (PATTERNS.md #16); on
//   a visual challenge we stop with CAPTCHA_UNSOLVABLE (contract rule 5).
// - The verification code is 6 single-char inputs that auto-advance; typing
//   the full code into box 0 also works (PATTERNS.md #15).
// - A listing is a "Company or Organization" created from the header
//   "Add your" dropdown (name + website modal).
// - The profile editor (?edit=description) AUTOSAVES PER FIELD: tagline,
//   description, founded year, markets typeahead ([role="option"] clicks),
//   one team member, logo via filechooser. Because it autosaves, dry_run
//   fills the signup form but never creates the company or edits a profile.
// - The location combobox is CITY-ONLY ("Norway" matched US towns) — we
//   leave it unset at ~70% profile strength rather than invent a city
//   (PATTERNS.md #18).
// - Optional product fields used when present: account_password (required
//   for signup), founded_year, founder_name + founder_role (team member),
//   categories (markets typeahead). Missing optional fields are skipped,
//   never invented.
//
// Contract: docs/ADAPTER_CONTRACT.md
//   node adapters/f6s.js <input.json> <output.json>

import fs from 'node:fs';
import path from 'node:path';
import {
  readInput, initRun, record, shot, launchBrowser, finish, runAdapter,
  firstPresent, missingField, detectCaptcha, fillByLabel, clickByText, escapeRe,
} from './lib/common.js';

const BASE = 'https://f6s.com';
const LOGIN_URL = `${BASE}/main/authorization/login`; // /sign-up is a 400 — do not use

async function main() {
  const { input, outputPath } = readInput();
  initRun(outputPath, input);
  const { product } = input;

  const missing = missingField(product, ['name', 'website']);
  if (missing) return finish('BLOCKED', { reason: `missing required product field: ${missing}` });
  const email = firstPresent(product.contact_email_business, product.contact_email);
  if (!email) return finish('BLOCKED', { reason: 'missing product.contact_email (or contact_email_business)' });
  const password = firstPresent(product.account_password);
  const tagline = firstPresent(product.tagline_66, product.tagline_50, product.tagline_111, product.tagline_39);
  const description = firstPresent(product.description_505, product.description_1341, product.description_150, product.description_145);

  const logoPath = product.logo ? path.resolve(product.logo) : null;
  const logoExists = logoPath && fs.existsSync(logoPath);

  const context = await launchBrowser(input);
  const page = context.pages()[0] || (await context.newPage());
  try {
    record('goto', LOGIN_URL);
    await page.goto(LOGIN_URL, { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(4000);
    await shot(page, 'login-loaded');

    // --- Session check: a verified account shows the header "Add your" menu ---
    const loggedIn = await isLoggedIn(page);
    record('session', { loggedIn });

    if (!loggedIn) {
      if (!password) {
        return finish('BLOCKED', {
          reason: 'no F6S session in the persistent profile and product.account_password is missing — F6S signup is email/password; add a per-site account password to product.json',
        });
      }
      const otpStatus = await signup(page, input, { email, password });
      if (otpStatus) return otpStatus; // NEEDS_EMAIL_VERIFICATION / CAPTCHA_UNSOLVABLE / ERROR / DRY_RUN
      if (!(await isLoggedIn(page))) {
        const tail = (await page.locator('body').innerText().catch(() => '')).slice(-400);
        return finish('ERROR', { reason: `signup submitted but not logged in and no OTP screen detected. tail=${tail}` });
      }
      record('signup_completed', {});
    }

    // dry_run never creates the company or edits the (autosaving) profile.
    if (input.dry_run) {
      return finish('DRY_RUN', { reason: 'dry_run: session verified; stopped before company creation because the F6S profile editor autosaves per field' });
    }

    // --- Company creation via the header "Add your" dropdown ---
    const companyUrl = await createCompany(page, product);
    if (!companyUrl) {
      return finish('ERROR', { reason: 'company creation failed — no profile URL after the Add-your modal' });
    }
    record('company_created', { url: companyUrl });
    await shot(page, 'company-created');

    // --- Profile editor (autosaves per field) ---
    await fillProfile(page, companyUrl, product, { tagline, description, logoPath: logoExists ? logoPath : null });

    // --- Verify the public page ---
    const publicUrl = companyUrl.replace(/\?.*$/, '').replace(/\/(edit|settings).*$/, '');
    record('goto', publicUrl);
    const resp = await page.goto(publicUrl, { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(4000);
    await shot(page, 'public-profile');
    const status = resp ? resp.status() : 0;
    const bodyText = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
    record('public_check', { url: publicUrl, status, hasName: bodyText.toLowerCase().includes(product.name.toLowerCase()) });
    if (status === 200 && bodyText.toLowerCase().includes(product.name.toLowerCase())) {
      return finish('SUBMITTED', {
        confirmation_text: `Public F6S profile live at ${publicUrl}: ${bodyText.slice(0, 700)}`,
        links_found: [publicUrl],
      });
    }
    return finish('ERROR', { reason: `public profile check failed: status=${status} url=${publicUrl}` });
  } finally {
    await context.close().catch(() => {});
  }
}

async function isLoggedIn(page) {
  const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 3000);
  if (/add your/i.test(body)) return true;
  if (/authorization\/login/i.test(page.url())) return false;
  return false;
}

// Fills and submits the Join form. Returns a finish() result when the run
// must stop (OTP handoff, captcha, error, dry_run), or null when signup
// completed inline (no OTP required).
async function signup(page, input, { email, password }) {
  const emailInput = page.locator('input[type="email"], input[name="email"]').first();
  const passwordInput = page.locator('input[type="password"]').first();
  if (!(await emailInput.count()) || !(await passwordInput.count())) {
    return finish('ERROR', { reason: 'email/password fields not found on the F6S login page — the Join form may have moved' });
  }
  await emailInput.fill(email);
  await passwordInput.fill(password);
  record('filled', { email });

  // reCAPTCHA v2: ONE plain click first (PATTERNS.md #16).
  const captcha = await detectCaptcha(page);
  if (captcha === 'recaptcha') {
    const clicked = await clickRecaptchaCheckbox(page);
    record('recaptcha_click', { clicked });
    await page.waitForTimeout(3000);
    if (await recaptchaChallengeVisible(page)) {
      await shot(page, 'recaptcha-challenge');
      return finish('CAPTCHA_UNSOLVABLE', {
        reason: 'reCAPTCHA v2 escalated to a visual image challenge after one plain click — retry later with a warmed profile (PATTERNS.md #16)',
      });
    }
  } else if (captcha) {
    return finish('CAPTCHA_UNSOLVABLE', { reason: `unexpected ${captcha} widget on the signup form` });
  }
  await shot(page, 'signup-filled');

  if (input.dry_run) {
    return finish('DRY_RUN', { reason: 'dry_run: Join form filled (and reCAPTCHA clicked), stopped before submit' });
  }

  const joined = await clickByText(page, /join|sign up|create account/i, { role: 'button' });
  record('join_clicked', joined);
  if (!joined) return finish('ERROR', { reason: 'Join button not found on the signup form' });
  await page.waitForTimeout(8000);
  await shot(page, 'after-join');

  // OTP screen: 6 single-char inputs that auto-advance (PATTERNS.md #15).
  const otpBoxes = page.locator('input[inputmode="numeric"], input[maxlength="1"]');
  if ((await otpBoxes.count()) >= 4) {
    await shot(page, 'otp-screen');
    return finish('NEEDS_EMAIL_VERIFICATION', {
      reason: 'F6S emailed a 6-digit verification code; OTP entry is one assisted step (see header comment). After the code is entered, re-run this adapter — it skips signup and builds the company profile unattended.',
      email_verification: { expected_sender_pattern: 'f6s.com', expected_subject_pattern: 'verif|code|confirm', max_wait_minutes: 30 },
      requested_action: {
        action: 'other',
        details: 'Read the 6-digit code from the campaign Gmail inbox and enter it in the F6S OTP screen in the same browser profile (re-submitting the login form re-sends the code). Then re-run the adapter.',
      },
    });
  }
  return null; // no OTP screen — signup may have completed inline
}

async function clickRecaptchaCheckbox(page) {
  for (const frame of page.frames()) {
    try {
      const anchor = frame.locator('#recaptcha-anchor');
      if (await anchor.count()) {
        await anchor.click({ timeout: 5000 });
        return true;
      }
    } catch { /* cross-origin or detached frame */ }
  }
  return false;
}

async function recaptchaChallengeVisible(page) {
  for (const frame of page.frames()) {
    try {
      if (!/recaptcha/i.test(frame.url())) continue;
      const challenge = frame.locator('img, .rc-imageselect-challenge, #rc-imageselect');
      if (await challenge.first().isVisible({ timeout: 1000 }).catch(() => false)) return true;
    } catch { /* ignore */ }
  }
  return false;
}

// Header "Add your" dropdown → "Company or Organization" modal (name + website).
// Returns the company profile URL or null.
async function createCompany(page, product) {
  const addYour = page.locator('button:has-text("Add your"), a:has-text("Add your"), [role="button"]:has-text("Add your")').first();
  if (!(await addYour.count())) {
    record('error', 'header "Add your" dropdown not found — logged-in layout may have changed');
    return null;
  }
  await addYour.click({ timeout: 5000 });
  await page.waitForTimeout(1500);
  const picked = await clickByText(page, /company or organization/i);
  record('add_your_picked', picked);
  if (!picked) return null;
  await page.waitForTimeout(2000);
  await shot(page, 'company-modal');

  const nameOk = (await fillByLabel(page, /^(company |organization )?name$/i, product.name))
    || await page.locator('input[name="name"], #name').first().fill(product.name).then(() => true).catch(() => false);
  const siteOk = (await fillByLabel(page, /website|url/i, product.website))
    || await page.locator('input[name="website"], input[name="url"], input[type="url"]').first().fill(product.website).then(() => true).catch(() => false);
  record('company_modal_filled', { nameOk, siteOk });
  if (!nameOk || !siteOk) return null;

  const created = await clickByText(page, /create|save|add/i, { role: 'button' });
  record('company_create_clicked', created);
  if (!created) return null;
  await page.waitForTimeout(8000);

  const m = page.url().match(/f6s\.com\/([a-z0-9][a-z0-9-]*)/i);
  if (m && !/main|settings|dashboard/i.test(m[1])) return `${BASE}/${m[1]}`;
  // Fallback: find the profile link on the page.
  const href = await page.evaluate(() => {
    const a = [...document.querySelectorAll('a[href]')].find((x) => /f6s\.com\/[a-z0-9-]+\/?$/i.test(x.href) && !/main|settings/i.test(x.href));
    return a ? a.href : null;
  });
  return href;
}

// Profile editor at <companyUrl>?edit=description — autosaves per field.
async function fillProfile(page, companyUrl, product, { tagline, description, logoPath }) {
  const editUrl = `${companyUrl}?edit=description`;
  record('goto', editUrl);
  await page.goto(editUrl, { waitUntil: 'load', timeout: 45000 });
  await page.waitForTimeout(4000);
  await shot(page, 'profile-editor');

  if (tagline) record('tagline', { ok: await fillByLabel(page, /tagline|headline|one[- ]liner/i, tagline) });
  if (description) record('description', { ok: await fillByLabel(page, /description|about/i, description) });

  const foundedYear = firstPresent(product.founded_year);
  if (foundedYear) record('founded_year', { ok: await fillByLabel(page, /founded|year/i, foundedYear) });
  else record('skip', 'no product.founded_year — founded field left unset');

  // Markets typeahead: type each category, click the matching [role="option"].
  const pickedMarkets = [];
  for (const cat of product.categories || []) {
    const box = page.locator('input[placeholder*="market" i], input[name*="market" i]').first();
    if (!(await box.count())) { record('warn', 'markets typeahead not found'); break; }
    await box.click({ timeout: 3000 }).catch(() => {});
    await box.fill(cat);
    await page.waitForTimeout(1800);
    const opt = page.locator('[role="option"]').filter({ hasText: new RegExp(escapeRe(cat), 'i') }).first();
    const ok = await opt.click({ timeout: 4000 }).then(() => true).catch(() => false);
    if (ok) pickedMarkets.push(cat);
    await page.waitForTimeout(500);
  }
  record('markets', { wanted: product.categories || [], picked: pickedMarkets });

  // Team member: only when both name and role are present (never invented).
  const founder = firstPresent(product.founder_name);
  const role = firstPresent(product.founder_role);
  if (founder && role) {
    const addMember = await clickByText(page, /add (a )?(team )?member/i);
    if (addMember) {
      await page.waitForTimeout(1500);
      const nameOk = await fillByLabel(page, /name/i, founder);
      const roleOk = await fillByLabel(page, /role|title|position/i, role);
      record('team_member', { nameOk, roleOk, founder, role });
      await clickByText(page, /save|add|confirm/i, { role: 'button' }).catch(() => {});
      await page.waitForTimeout(2000);
    } else {
      record('warn', 'add-team-member control not found');
    }
  } else {
    record('skip', 'founder_name/founder_role incomplete — team member left unset');
  }

  // Logo via filechooser.
  if (logoPath) {
    try {
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 5000 }),
        page.locator('text=/upload (a )?logo|change logo|add logo/i').first().click({ timeout: 4000 }),
      ]);
      await chooser.setFiles(logoPath);
      await page.waitForTimeout(4000); // autosave
      record('logo_uploaded', logoPath);
    } catch {
      record('warn', 'logo upload control not found — continuing without logo');
    }
  } else {
    record('warn', 'no logo asset on disk — continuing without logo');
  }

  // Location combobox is CITY-ONLY — deliberately left unset (PATTERNS.md #18).
  record('skip', 'location combobox left unset (city-only; country would geolocate wrong)');
  await page.waitForTimeout(3000); // let autosaves settle
  await shot(page, 'profile-filled');
}

await runAdapter(main);
