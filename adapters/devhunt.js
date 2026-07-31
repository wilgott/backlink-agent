// Adapter: DevHunt (https://devhunt.org)
// Next.js SPA; GitHub OAuth only (no email/password signup). See
// docs/PATTERNS.md sections 14, 17, 19 — read them before modifying this file.
//
// $49-BUTTON QUIRK (proven 2026-07-29, pilot campaign): the only visible
// launch button says "$49", but clicking it created the listing FREE
// immediately — payment is a POST-SUBMIT upsell page. We click the button,
// back out of any checkout that appears, and verify the listing exists
// before ever considering NEEDS_PAYMENT (PATTERNS.md #17). $0 spent.
//
// AUTHENTICATION — REQUIRES A PRE-AUTHENTICATED PERSISTENT PROFILE.
// Only GitHub OAuth works. A human must complete it ONCE with the browser
// pointed at paths.user_data_dir (run headed, sign in with GitHub, close).
// Every later run reuses that session. If the session is missing or expired,
// this adapter emits NEEDS_OAUTH with instructions — it never tries to log
// in itself (same convention as openhunts.js). If the profile dir is locked
// by a leftover Chromium process, see PATTERNS.md #19 (rsync minus Singleton*).
//
// Field notes:
// - NO submit button exists until the required launch-week <select> is
//   chosen — pick the earliest week to materialize it (PATTERNS.md #14).
// - Form fields: tool_name, slogan, tool_website, tool_description,
//   pricing-type radio (Free), logo-upload, category typeahead
//   (input[placeholder="Add a category"] + [role="option"] clicks).
// - Screenshots use a SINGLE-FILE input: set one file, wait ~5s for the
//   upload, repeat for the next.
// - Success evidence: devhunt.org/tool/<slug> returns 200 and the outbound
//   link to the product site carries rel="" (dofollow).
//
// Contract: docs/ADAPTER_CONTRACT.md
//   node adapters/devhunt.js <input.json> <output.json>

import fs from 'node:fs';
import path from 'node:path';
import {
  readInput, initRun, record, shot, launchBrowser, finish, runAdapter,
  firstPresent, missingField, fillByLabel, checkRadioByLabelText, clickByText, escapeRe,
} from './lib/common.js';

const BASE = 'https://devhunt.org';
const TOOLS_URL = `${BASE}/account/tools`;
const NEW_TOOL_URL = `${BASE}/account/tools/new`;

async function main() {
  const { input, outputPath } = readInput();
  initRun(outputPath, input);
  const { product } = input;

  const missing = missingField(product, ['name', 'website']);
  if (missing) return finish('BLOCKED', { reason: `missing required product field: ${missing}` });
  const slogan = firstPresent(product.tagline_50, product.tagline_66, product.tagline_39, product.tagline_111);
  if (!slogan) return finish('BLOCKED', { reason: 'missing a product tagline (DevHunt slogan)' });
  const description = firstPresent(product.description_505, product.description_150, product.description_145, product.description_1341);
  if (!description) return finish('BLOCKED', { reason: 'missing a product description' });

  const logoPath = product.logo ? path.resolve(product.logo) : null;
  const logoExists = logoPath && fs.existsSync(logoPath);
  const screenshots = (product.screenshots || []).map((p) => path.resolve(p)).filter((p) => fs.existsSync(p));

  const context = await launchBrowser(input);
  const page = context.pages()[0] || (await context.newPage());
  try {
    record('goto', TOOLS_URL);
    await page.goto(TOOLS_URL, { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(5000);
    await shot(page, 'tools-loaded');

    // --- Session gate: GitHub OAuth must already exist in the profile ---
    if (await needsAuth(page)) {
      return finish('NEEDS_OAUTH', {
        reason: 'no active session in the persistent profile; DevHunt only supports GitHub OAuth',
        requested_action: {
          action: 'oauth_login',
          details: `Run this adapter once with "headless": false and complete the GitHub OAuth on ${BASE} in the opened window, then close it. The session persists in paths.user_data_dir and all later runs are unattended.`,
        },
      });
    }
    record('session', { loggedIn: true });

    // Profile completion (first login may prompt for it) — fill only from product data.
    const namePrompt = page.locator('input[name="name"], input[name="full_name"]').first();
    if (await namePrompt.count()) {
      const founder = firstPresent(product.founder_name, product.name);
      await namePrompt.fill(founder).catch(() => {});
      record('profile_completion', { filled: founder });
      await clickByText(page, /save|continue|confirm/i, { role: 'button' }).catch(() => {});
      await page.waitForTimeout(3000);
    }

    // --- New tool form ---
    record('goto', NEW_TOOL_URL);
    await page.goto(NEW_TOOL_URL, { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(4000);
    await shot(page, 'new-tool-form');

    const filled = {
      tool_name: await fillField(page, 'tool_name', product.name),
      slogan: await fillField(page, 'slogan', slogan),
      tool_website: await fillField(page, 'tool_website', product.website),
      tool_description: await fillField(page, 'tool_description', description),
    };
    record('filled', filled);
    if (!filled.tool_name || !filled.tool_website) {
      return finish('ERROR', { reason: `core fields not found on the new-tool form: ${JSON.stringify(filled)}` });
    }

    // Pricing type: Free.
    const pricing = (await checkRadioByLabelText(page, 'pricing-type', /free/i))
      || (await clickByText(page, /^free$/i));
    record('pricing', { picked: pricing });

    // Logo upload.
    if (logoExists) {
      const logoInput = page.locator('input#logo-upload, input[name="logo-upload"], input[name="logo"]').first();
      const ok = await logoInput.setInputFiles(logoPath).then(() => true).catch(() => false);
      record('logo_uploaded', ok ? logoPath : false);
      await page.waitForTimeout(4000);
    } else {
      record('warn', 'no logo asset on disk — continuing without logo');
    }

    // Screenshots: single-file input, one at a time with ~5s upload waits.
    for (const s of screenshots) {
      const shotInput = page.locator('input#screenshots, input[name="screenshots"], input[name="screenshot"]').first();
      const ok = await shotInput.setInputFiles(s).then(() => true).catch(() => false);
      record('screenshot_uploaded', ok ? s : false);
      await page.waitForTimeout(5000);
    }

    // Categories: typeahead input[placeholder="Add a category"] + [role="option"].
    const pickedCategories = [];
    for (const cat of product.categories || []) {
      const box = page.locator('input[placeholder="Add a category"]').first();
      if (!(await box.count())) { record('warn', 'category typeahead not found'); break; }
      await box.click({ timeout: 3000 }).catch(() => {});
      await box.fill(cat);
      await page.waitForTimeout(1800);
      const opt = page.locator('[role="option"]').filter({ hasText: new RegExp(escapeRe(cat), 'i') }).first();
      const ok = await opt.click({ timeout: 4000 }).then(() => true).catch(() => false);
      if (ok) pickedCategories.push(cat);
      await page.waitForTimeout(500);
    }
    record('categories', { wanted: product.categories || [], picked: pickedCategories });

    // Launch week: the gating field — no submit button exists until a week is
    // chosen (PATTERNS.md #14). Pick the earliest week.
    const chosenWeek = await page.evaluate(() => {
      for (const s of document.querySelectorAll('select')) {
        const opts = [...s.options].filter((o) => o.value && !/select|choose|pick/i.test(o.textContent));
        if (opts.length && /week|20\d\d/i.test(opts.map((o) => o.textContent).join(' '))) {
          s.value = opts[0].value; // options are chronological — first is earliest
          s.dispatchEvent(new Event('change', { bubbles: true }));
          return opts[0].textContent.trim().slice(0, 80);
        }
      }
      return null;
    });
    record('launch_week', chosenWeek);
    if (!chosenWeek) {
      return finish('ERROR', { reason: 'launch-week select not found — without it the submit button never renders (PATTERNS.md #14)' });
    }
    await page.waitForTimeout(2000); // submit button materializes
    await shot(page, 'form-filled');

    if (input.dry_run) {
      return finish('DRY_RUN', { reason: 'dry_run: new-tool form filled (Free pricing, earliest week), stopped before the launch button' });
    }

    // --- Launch. The button may say "$49" — it creates the listing FREE;
    //     payment is a post-submit upsell (PATTERNS.md #17, header comment). ---
    const launch = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')]
        .find((x) => /launch|submit/i.test(x.textContent) && x.textContent.length < 120);
      if (b) { b.click(); return b.textContent.trim(); }
      return null;
    });
    record('launch_clicked', launch);
    if (!launch) return finish('ERROR', { reason: 'launch button not found after selecting the launch week' });
    await page.waitForTimeout(8000);
    await shot(page, 'after-launch');

    // Back out of any checkout/upsell — the listing already exists.
    const postUrl = page.url();
    const postBody = (await page.locator('body').innerText().catch(() => '')).slice(0, 800);
    if (/checkout|payment|stripe|polar/i.test(postUrl) || /checkout|pay now|card details/i.test(postBody)) {
      record('upsell_backed_out', { url: postUrl });
      await page.goBack({ waitUntil: 'load', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }

    // --- Verify the listing page: 200 + dofollow outbound link ---
    const slug = product.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const listingUrl = `${BASE}/tool/${slug}`;
    record('goto', listingUrl);
    const resp = await page.goto(listingUrl, { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(4000);
    await shot(page, 'listing-page');
    const status = resp ? resp.status() : 0;
    const host = new URL(product.website).host;
    const linkInfo = await page.evaluate((h) => {
      const a = [...document.querySelectorAll('a[href]')].find((x) => x.href.includes(h));
      return a ? { href: a.href, rel: a.getAttribute('rel') || '' } : null;
    }, host);
    record('listing_check', { url: listingUrl, status, link: linkInfo });

    if (status === 200) {
      const rel = linkInfo ? linkInfo.rel : null;
      return finish('SUBMITTED', {
        confirmation_text: `DevHunt listing live at ${listingUrl}` + (linkInfo ? ` (outbound link rel="${rel}"${rel === '' ? ' — dofollow' : ''})` : ' (outbound link not found on page)'),
        links_found: [listingUrl, ...(linkInfo ? [linkInfo.href] : [])],
      });
    }
    return finish('ERROR', { reason: `listing page check failed: status=${status} url=${listingUrl} (may still be propagating — recheck before retrying)` });
  } finally {
    await context.close().catch(() => {});
  }
}

async function needsAuth(page) {
  if (/\/(sign-?in|log-?in|login|auth)/i.test(page.url())) return true;
  const signIn = await page.locator('a:has-text("Sign in"), button:has-text("Sign in"), a:has-text("Login with GitHub"), button:has-text("Login with GitHub"), a:has-text("Sign in with GitHub"), button:has-text("Sign in with GitHub")').count();
  if (!signIn) return false;
  // A tools dashboard with an active session shows the user's tools/new-tool UI.
  const hasToolsUi = await page.locator('a:has-text("New tool"), button:has-text("New tool"), a[href*="/account/tools"]').count();
  return !hasToolsUi;
}

// Fill by input/textarea name (DevHunt uses stable names), falling back to label.
async function fillField(page, name, value) {
  const loc = page.locator(`input[name="${name}"], textarea[name="${name}"]`).first();
  if (await loc.count()) {
    await loc.fill(value, { timeout: 5000 }).catch(() => {});
    return true;
  }
  return fillByLabel(page, new RegExp(name.replace(/_/g, ' '), 'i'), value);
}

await runAdapter(main);
