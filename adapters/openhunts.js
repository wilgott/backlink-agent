// Adapter: OpenHunts (https://openhunts.com/projects/submit)
// Multi-step in-memory wizard on the better-auth stack (see docs/PATTERNS.md
// sections 3, 5, 8, 9 — read them before modifying this file).
//
// AUTHENTICATION — REQUIRES A PRE-AUTHENTICATED PERSISTENT PROFILE.
// Email/password signup is DISABLED server-side on this network
// (EMAIL_AND_PASSWORD_SIGN_UP_IS_NOT_ENABLED); magic-link/OTP 404s. Only
// Google/GitHub OAuth works. A human must complete OAuth ONCE with the
// browser pointed at paths.user_data_dir (e.g. run headed, log in via GitHub,
// close). Every later run reuses that session. If the session is missing or
// expired, this adapter emits NEEDS_OAUTH with instructions — it never tries
// to register or log in itself.
//
// Field notes (proven 2026-07-29, klinky.io campaign):
// - Cloudflare Turnstile is present and AUTO-SOLVES (~5s); we never touch it
//   and never report CAPTCHA_UNSOLVABLE for it (PATTERNS.md #3).
// - The wizard keeps state in memory only: ONE session, ZERO reloads
//   (PATTERNS.md #8). Any reload restarts the wizard from scratch.
// - Categories are div.cursor-pointer chips; platforms are lowercase text in
//   span.capitalize (PATTERNS.md #9).
// - The $9.9 Premium skip-queue tier is PRE-SELECTED; we always select the
//   $0 Free tier and verify no paid option remains selected (PATTERNS.md #5).
// - Free launch weeks can be Full far into the future; the "Add our badge"
//   path (reciprocal badge on the product site, manual review ~3 weeks,
//   PATTERNS.md #6) is taken when available, otherwise the first non-Full
//   week is chosen.
// - Success evidence: redirect to the dashboard and/or "PENDING REVIEW".
//
// Contract: docs/ADAPTER_CONTRACT.md
//   node adapters/openhunts.js <input.json> <output.json>

import fs from 'node:fs';
import path from 'node:path';
import {
  readInput, initRun, record, shot, launchBrowser, finish, runAdapter,
  firstPresent, missingField,
} from './lib/common.js';

const DEFAULT_URL = 'https://openhunts.com/projects/submit';

// Generic fallbacks used only when product.categories does not map onto the
// site's chips (same convention as the startup-stash adapter).
const CATEGORY_FALLBACKS = ['Marketing Tools', 'Developer Tools', 'Business Analytics'];

async function main() {
  const { input, outputPath } = readInput();
  initRun(outputPath, input);
  const { product } = input;
  const url = (input.site && input.site.submission_url) || DEFAULT_URL;

  const missing = missingField(product, ['name', 'website']);
  if (missing) return finish('BLOCKED', { reason: `missing required product field: ${missing}` });

  const tagline = firstPresent(product.tagline_39, product.tagline_50, product.tagline_66);
  if (!tagline) return finish('BLOCKED', { reason: 'missing product.tagline_39 (or any tagline)' });

  const wantedCategories = [...(product.categories || []), ...CATEGORY_FALLBACKS]
    .filter((v, i, a) => v && a.indexOf(v) === i);
  // 'web' is definitionally true for a website submission; product.platforms
  // (optional, non-schema) can add more. Lowercase: chips hold lowercase text.
  const wantedPlatforms = ['web', ...(product.platforms || [])]
    .map((p) => String(p).toLowerCase())
    .filter((v, i, a) => a.indexOf(v) === i);
  const pricingLabel = firstPresent(product.pricing_model, product.pricing) || 'Freemium';

  const imagePath = [product.logo, ...(product.screenshots || [])]
    .filter(Boolean)
    .map((p) => path.resolve(p))
    .find((p) => fs.existsSync(p)) || null;

  const context = await launchBrowser(input);
  const page = context.pages()[0] || (await context.newPage());
  try {
    record('goto', url);
    await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(4000);
    await shot(page, 'wizard-loaded');

    // --- Session gate: OAuth must already exist in the persistent profile ---
    const hasWizard = await page.locator('#url-analyzer-input').count();
    if (!hasWizard) {
      const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 500);
      if (/sign in|log in|github|google/i.test(body) || /sign-in|login|auth/i.test(page.url())) {
        return finish('NEEDS_OAUTH', {
          reason: 'no active session in the persistent profile; email/password signup is disabled server-side on this site (better-auth)',
          requested_action: {
            action: 'oauth_login',
            details: `Run this adapter once with "headless": false and complete the Google/GitHub OAuth on ${new URL(url).origin} in the opened window, then close it. The session persists in paths.user_data_dir and all later runs are unattended.`,
          },
        });
      }
      return finish('ERROR', { reason: `unexpected page (no wizard, no sign-in): ${body.slice(0, 200)}` });
    }

    // --- Step 1: URL auto-fill, then exact fields (Turnstile auto-solves; never touch it) ---
    await page.fill('#url-analyzer-input', product.website);
    await page.click('button:has-text("Auto-fill")');
    await page.waitForTimeout(12000); // analyzer + Turnstile settle
    await page.fill('#tagline', tagline);
    if (product.founder_github) {
      await page.fill('#githubUrl', product.founder_github).catch(() => record('warn', 'no #githubUrl field'));
    }
    record('filled', { website: product.website, tagline });

    // Categories: div.cursor-pointer chips, max 3, case-insensitive text match.
    const pickedCategories = [];
    for (const c of wantedCategories) {
      if (pickedCategories.length >= 3) break;
      const clicked = await page.evaluate((want) => {
        const el = [...document.querySelectorAll('div.cursor-pointer')]
          .find((d) => (d.innerText || '').trim().toLowerCase() === want.toLowerCase());
        if (el) { el.click(); return (el.innerText || '').trim().slice(0, 60); }
        return null;
      }, c).catch(() => null);
      if (clicked) pickedCategories.push(clicked);
      await page.waitForTimeout(300);
    }
    record('categories', { wanted: wantedCategories, picked: pickedCategories });
    if (!pickedCategories.length) {
      return finish('BLOCKED', { reason: `no category chip matched ${JSON.stringify(wantedCategories)}` });
    }

    // Platforms: lowercase text inside span.capitalize — match lowercase.
    const pickedPlatforms = await page.evaluate((wanted) => {
      const picked = [];
      document.querySelectorAll('span.capitalize').forEach((s) => {
        const t = s.textContent.trim().toLowerCase();
        if (wanted.includes(t)) {
          s.closest('div.cursor-pointer')?.click();
          picked.push(t);
        }
      });
      return picked;
    }, wantedPlatforms);
    record('platforms', { wanted: wantedPlatforms, picked: pickedPlatforms });

    // Pricing chip.
    const pricingClicked = await page.evaluate((want) => {
      const el = [...document.querySelectorAll('div.cursor-pointer')]
        .find((d) => (d.innerText || '').trim().toLowerCase() === want.toLowerCase());
      if (el) { el.click(); return (el.innerText || '').trim().slice(0, 60); }
      return null;
    }, pricingLabel).catch(() => null);
    record('pricing', { wanted: pricingLabel, picked: pricingClicked });

    // Image upload (optional — skip cleanly if no asset exists).
    if (imagePath) {
      try {
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 5000 }),
          page.locator('text=Upload Product Image').first().click({ timeout: 4000 }),
        ]);
        await chooser.setFiles(imagePath);
        record('image_uploaded', imagePath);
      } catch {
        record('warn', 'image upload control not found — continuing without image');
      }
    } else {
      record('warn', 'no logo/screenshot asset found on disk — continuing without image');
    }
    await page.waitForTimeout(1500);
    await shot(page, 'step1-filled');

    // --- Step 2: plan selection ---
    await page.locator('button:has-text("Next")').click({ timeout: 5000 });
    await page.waitForTimeout(5000);
    await shot(page, 'plan-step');

    // Select the $0 Free tier (Premium $9.9 is pre-selected — selecting the
    // Free radio deselects it, then we verify nothing paid remains selected).
    const freePicked = await page.evaluate(() => {
      const free = [...document.querySelectorAll('label, div')]
        .find((e) => e.textContent.includes('$0') && /free/i.test(e.textContent) && e.textContent.length < 200);
      const target = free?.querySelector('input[type="radio"], [role="radio"]') || free;
      if (target) { target.click(); return true; }
      return false;
    });
    if (!freePicked) {
      return finish('ERROR', { reason: 'could not locate the $0 Free plan option on the plan step' });
    }
    await page.waitForTimeout(1500);
    const deselected = await page.evaluate(() => {
      const stillPaid = [];
      for (const el of document.querySelectorAll('[aria-checked="true"], input:checked')) {
        const card = el.closest('label,div') || el;
        const t = (card.innerText || '').trim();
        if (/\$\s*[1-9]|premium/i.test(t) && t.length < 300 && !/\$0/.test(t)) {
          el.click();
          stillPaid.push(t.slice(0, 80));
        }
      }
      return stillPaid;
    });
    record('deselected_paid_options', deselected);
    if (deselected.length) record('warn', `paid option(s) were still selected after picking Free: ${deselected.join(' | ')}`);

    // Launch week: prefer the reciprocal-badge path (free queue skip, manual
    // review ~3 weeks); otherwise take the first week that is not Full.
    const badgeClicked = await page.locator('button:has-text("Add our badge"), a:has-text("Add our badge")')
      .first().click({ timeout: 6000 }).then(() => true).catch(() => false);
    if (badgeClicked) {
      record('launch_path', 'badge');
      await page.waitForTimeout(2500);
      await page.locator('button:has-text("Verify badge")').click({ timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(8000);
      record('badge_verify_result', (await page.locator('body').innerText().catch(() => '')).slice(-400));
    } else {
      const week = await page.evaluate(() => {
        const el = [...document.querySelectorAll('div.cursor-pointer, label, button')]
          .find((d) => {
            const t = (d.innerText || '').trim();
            return t.length < 120 && /week|launch/i.test(t) && !/full/i.test(t);
          });
        if (el) { el.click(); return (el.innerText || '').trim().slice(0, 80); }
        return null;
      });
      record('launch_path', week ? `week: ${week}` : 'none-found');
      if (!week) {
        return finish('BLOCKED', {
          reason: 'no badge path offered and every launch week is Full — no free slot available',
          requested_action: { action: 'other', details: 'All free launch weeks are Full and no "Add our badge" path was found. Re-check the site or add the directory badge to the product site if it offers one.' },
        });
      }
    }
    await shot(page, 'plan-selected');

    if (input.dry_run) {
      return finish('DRY_RUN', { reason: 'dry_run: wizard filled (Free tier, paid upsell deselected), stopped before final submit' });
    }

    // --- Final submit (label becomes "Submit for admin review" after badge verify) ---
    await page.keyboard.press('Escape'); // close badge modal if still open
    await page.waitForTimeout(1000);
    const submitted = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')]
        .find((x) => /submit for admin review|confirm and submit|submit/i.test(x.textContent));
      if (b) {
        b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return b.textContent.trim();
      }
      return null;
    });
    record('submit_clicked', submitted);
    if (!submitted) return finish('ERROR', { reason: 'final submit button not found' });
    await page.waitForTimeout(9000);
    await shot(page, 'after-submit');

    // --- Confirmation evidence: dashboard redirect and/or PENDING REVIEW ---
    const finalUrl = page.url();
    const bodyText = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
    record('after_submit', { url: finalUrl, tail: bodyText.slice(-300) });
    if (/dashboard|projects(?!\/submit)/i.test(finalUrl) || /pending review|under review|submitted/i.test(bodyText)) {
      return finish('SUBMITTED', {
        confirmation_text: bodyText.slice(-800),
        links_found: /dashboard|projects/i.test(finalUrl) ? [finalUrl] : [],
      });
    }
    if (/sign in|log in/i.test(bodyText) && !/pending|review/i.test(bodyText)) {
      return finish('NEEDS_OAUTH', {
        reason: 'session lost mid-wizard (sign-in shown after submit attempt)',
        requested_action: { action: 'oauth_login', details: 'Re-run once headed and complete Google/GitHub OAuth to refresh the persistent profile session.' },
      });
    }
    return finish('ERROR', { reason: `no confirmation evidence after submit. url=${finalUrl} tail=${bodyText.slice(-300)}` });
  } finally {
    await context.close().catch(() => {});
  }
}

await runAdapter(main);
