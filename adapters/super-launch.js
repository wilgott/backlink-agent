// Adapter: Super Launch (https://super-launch.app/submit)
// Two-step React form, public (Sign In present but not required to fill).
// Step 1: tool info. Step 2: submission type (must pick FREE, never pay).
//
// Contract: docs/ADAPTER_CONTRACT.md
//   node adapters/super-launch.js <input.json> <output.json>

import fs from 'node:fs';
import path from 'node:path';
import {
  readInput, initRun, record, shot, launchBrowser, finish, runAdapter,
  firstPresent, trimTo, missingField,
} from './lib/common.js';

const DEFAULT_URL = 'https://super-launch.app/submit';
const CATEGORY_FALLBACKS = ['Productivity', 'Developer Tools', 'Marketing', 'Analytics', 'SEO', 'Business', 'SaaS'];
const PLATFORM_FALLBACKS = ['Web', 'Website', 'Browser', 'SaaS'];

async function waitTurnstile(page, seconds = 20) {
  for (let i = 0; i < seconds; i++) {
    const tok = await page.evaluate(() => {
      const el = document.querySelector('input[name="cf-turnstile-response"]');
      return el && el.value ? el.value.slice(0, 16) : '';
    });
    if (tok) { record('turnstile', { i, present: true }); return true; }
    await page.waitForTimeout(1000);
  }
  record('turnstile', 'no token after wait');
  return false;
}


async function pickFromMenu(page, buttonRe, wanted, maxN) {
  await page.evaluate(() => window.scrollTo(0, 700));
  await page.waitForTimeout(300);
  let btn = page.getByRole('button', { name: buttonRe }).first();
  if (!(await btn.count())) btn = page.getByRole('combobox', { name: buttonRe }).first();
  if (!(await btn.count())) {
    const src = buttonRe instanceof RegExp ? buttonRe.source : String(buttonRe);
    btn = page.locator('button, [role="combobox"], [role="button"]').filter({ hasText: new RegExp(src, 'i') }).first();
  }
  if (!(await btn.count())) {
    record('warn', `menu button not found: ${buttonRe}`);
    const all = await page.evaluate(() => [...document.querySelectorAll('button,[role="combobox"],[role="button"]')].map(e => (e.innerText||'').trim().slice(0,80)).filter(Boolean).slice(0,40));
    record('all_buttons', all);
    return [];
  }
  await btn.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(600);
  const picked = [];
  const options = page.locator('[role="option"], [cmdk-item], [data-radix-collection-item]');
  const n = await options.count();
  const texts = [];
  for (let i = 0; i < Math.min(n, 80); i++) {
    texts.push(((await options.nth(i).innerText().catch(() => '')) || '').trim());
  }
  record('menu_options', { button: String(buttonRe), texts: texts.slice(0, 40) });
  for (const want of wanted) {
    if (picked.length >= maxN) break;
    const idx = texts.findIndex((t) => t && t.toLowerCase() === want.toLowerCase());
    const idx2 = idx >= 0 ? idx : texts.findIndex((t) => t && t.toLowerCase().includes(want.toLowerCase()));
    if (idx2 >= 0 && !picked.includes(texts[idx2])) {
      await options.nth(idx2).click({ timeout: 3000 }).catch(() => {});
      picked.push(texts[idx2]);
      await page.waitForTimeout(250);
    }
  }
  if (!picked.length && texts.length) {
    // pick first non-empty options rather than invent a category name
    for (const t of texts) {
      if (picked.length >= Math.min(2, maxN)) break;
      if (t && t.length < 40) {
        const idx = texts.indexOf(t);
        await options.nth(idx).click({ timeout: 3000 }).catch(() => {});
        picked.push(t);
        await page.waitForTimeout(250);
      }
    }
  }
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
  return picked;
}

async function main() {
  const { input, outputPath } = readInput();
  initRun(outputPath, input);
  const { product } = input;
  const url = (input.site && input.site.submission_url) || DEFAULT_URL;

  const missing = missingField(product, ['name', 'website', 'contact_email']);
  if (missing) return finish('BLOCKED', { reason: `missing required product field: ${missing}` });
  const tagline = trimTo(firstPresent(product.tagline_111, product.tagline_50, product.tagline_39), 160);
  const description = firstPresent(product.description_1341, product.description_505, product.description_2192);
  if (!tagline) return finish('BLOCKED', { reason: 'missing product tagline' });
  if (!description || description.length < 500) return finish('BLOCKED', { reason: 'description shorter than 500 chars required by form' });
  const logoPath = product.logo ? path.resolve(product.logo) : null;
  if (!logoPath || !fs.existsSync(logoPath)) return finish('BLOCKED', { reason: 'logo file missing (form requires logo <=500kb)' });
  const shotPath = (product.screenshots || []).map((p) => path.resolve(p)).find((p) => fs.existsSync(p)) || null;

  const context = await launchBrowser(input);
  const page = context.pages()[0] || (await context.newPage());
  try {
    record('goto', url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);
    await shot(page, 'form-loaded');

    await page.locator('input[name="url"]').first().fill(product.website);
    await page.locator('input[name="name"]').first().fill(product.name);
    await page.locator('input[name="tagline"]').first().fill(tagline);
    await page.locator('textarea[name="description"]').first().fill(description);
    record('filled_text', { name: product.name, tagline, description_chars: description.length });

    const logoInput = page.locator('#logo-image-upload, input[type="file"]').first();
    if (await logoInput.count()) {
      await logoInput.setInputFiles(logoPath);
      record('uploaded_logo', logoPath);
      await page.waitForTimeout(800);
    }
    if (shotPath) {
      const files = page.locator('input[type="file"]');
      if ((await files.count()) > 1) {
        await files.nth(1).setInputFiles(shotPath).catch((e) => record('warn', `screenshot upload: ${e.message}`));
      }
    }

    const wantedCats = [...(product.categories || []), ...CATEGORY_FALLBACKS];
    const cats = await pickFromMenu(page, /select up to 3 categories/i, wantedCats, 3);
    record('categories', cats);
    const plats = await pickFromMenu(page, /select platforms/i, PLATFORM_FALLBACKS, 2);
    record('platforms', plats);

    // Pricing: native <select> or a button+menu. Prefer visible Free.
    const pricingSelect = page.locator('select').first();
    let priced = false;
    if (await pricingSelect.count()) {
      const opts = await pricingSelect.locator('option').allTextContents();
      record('pricing_options', opts);
      const freeOpt = opts.find((o) => /^free$/i.test(o.trim()));
      if (freeOpt) {
        await pricingSelect.selectOption({ label: freeOpt });
        priced = true;
      }
    }
    if (!priced) {
      const pbtn = page.getByRole('button', { name: /select pricing model/i }).first();
      if (await pbtn.count()) {
        await pbtn.click().catch(() => {});
        await page.waitForTimeout(400);
        await page.getByRole('option', { name: /^free$/i }).click().catch(() => {});
        priced = true;
      }
    }
    record('pricing', { priced });

    const yearSelect = page.locator('select').nth(1);
    if (await yearSelect.count()) {
      if (product.founded_year) await yearSelect.selectOption({ label: String(product.founded_year) }).catch(() => {});
    }
    if (product.founder_github) {
      await page.locator('input[name="githubUrl"]').fill(product.founder_github).catch(() => {});
    }
    const emailBox = page.locator('input[type="email"]').first();
    if (await emailBox.count()) await emailBox.fill(product.contact_email);

    await shot(page, 'step1-filled');

    const next = page.getByRole('button', { name: /^next$/i }).first();
    if (!(await next.count())) return finish('ERROR', { reason: 'Next button not found on step 1' });
    await next.scrollIntoViewIfNeeded().catch(() => {});
    await next.click({ timeout: 8000 });
    await page.waitForTimeout(2500);
    await shot(page, 'after-next');
    const stillStep1 = await page.getByText(/please fill in all required/i).count();
    const step2active = await page.getByText(/submission type/i).count();
    if (stillStep1 && await page.locator('input[name="url"]').count()) {
      // still on step 1 — required fields missing
      const toast = await page.getByText(/please fill in all required/i).innerText().catch(() => 'required fields');
      if (input.dry_run) {
        return finish('DRY_RUN', { reason: `dry_run: still on step 1 after Next (${toast}). cats=${JSON.stringify(cats)} plats=${JSON.stringify(plats)}` });
      }
      return finish('ERROR', { reason: `step 1 validation blocked Next: ${toast}. categories=${JSON.stringify(cats)} platforms=${JSON.stringify(plats)}` });
    }

    const body2 = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    record('step2_text', body2.slice(0, 800));

    // Deselect any paid/pre-ticked option; click Free/Standard/Basic.
    const deselected = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('[aria-checked="true"], input:checked')) {
        const card = el.closest('label,div,button') || el;
        const t = (card.innerText || '').trim();
        if (/\$\s*[1-9]|premium|featured|pro\b|lifetime/i.test(t) && t.length < 400) {
          el.click();
          out.push(t.slice(0, 100));
        }
      }
      return out;
    });
    record('deselected_paid_options', deselected);

    const freeCard = page.getByText(/free (submission|listing|review)|submit for free|^free$/i).first();
    if (await freeCard.count()) {
      await freeCard.click({ timeout: 5000 }).catch(() => record('warn', 'could not click free card'));
    }
    // Click a card whose text includes Free and $0 if present
    await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('button, [role="button"], [role="radio"], label, div')];
      const free = nodes.find((n) => {
        const t = (n.innerText || '').trim();
        return t.length > 0 && t.length < 400 && /free/i.test(t) && /\$0|no cost|7 day|72h|review/i.test(t);
      });
      if (free) free.click();
    });
    await page.waitForTimeout(500);
    await shot(page, 'step2-free');

    // Capture the free-tier badge embed (required footer backlink).
    const badgeHtml = await page.evaluate(() => {
      const pre = document.querySelector('pre, code, textarea');
      if (pre && /dofollow/i.test(pre.innerText || pre.value || '')) return (pre.innerText || pre.value).slice(0, 600);
      const links = [...document.querySelectorAll('a')].filter(a => /dofollow\.tools/i.test(a.href || '') && /featured|badge/i.test(a.innerText || a.outerHTML));
      return links[0] ? links[0].outerHTML.slice(0, 600) : '';
    });
    record('badge_snippet', badgeHtml || 'Add dofollow backlink to our site in your website footer.');
    await page.getByText(/free submission/i).first().scrollIntoViewIfNeeded().catch(() => {});
    await shot(page, 'free-section');

    if (input.dry_run) {
      return finish('DRY_RUN', { reason: 'dry_run: step 1+2 filled, stopped before final submit. free-tier requires footer badge.' });
    }

    // Free card is below paid "Go Submit" buttons. Prefer the free section
    // (badge verification required) — never the $9.9/$19.9 cards.
    let submit = page.locator('div,section,article').filter({ hasText: /badge verification required/i }).getByRole('button', { name: /go submit|submit/i }).first();
    if (!(await submit.count())) {
      submit = page.getByRole('button', { name: /go submit/i }).last();
    }
    if (!(await submit.count())) {
      return finish('ERROR', { reason: `no free Go Submit button on step 2. body=${body2.slice(0, 250)}` });
    }
    // Copy badge embed if present (do not invent; record exact text).
    const copyBtn = page.getByRole('button', { name: /copy dark embed/i }).first();
    if (await copyBtn.count()) {
      await copyBtn.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(400);
    }
    record('submit', await submit.innerText().catch(() => 'submit'));
    await submit.click({ timeout: 8000 });
    await page.waitForTimeout(4000);
    await shot(page, 'after-submit');
    const after = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 2000);
    const afterUrl = page.url();
    record('after_submit', { afterUrl, after: after.slice(0, 600) });

    if (/sign in|log in|create (an )?account/i.test(after) && /sign-in|login|signup/i.test(afterUrl)) {
      const email = product.contact_email;
      const emailBox = page.locator('input[type="email"]').first();
      if (await emailBox.count() && email) {
        await emailBox.click();
        await emailBox.fill('');
        await emailBox.pressSequentially(email, { delay: 35 });
        await emailBox.blur();
        record('login_email', email);
        await shot(page, 'login-email-typed');
        const ts = await waitTurnstile(page, 20);
        const send = page.getByRole('button', { name: /send code/i }).first();
        if (await send.count()) {
          for (let i = 0; i < 20 && !(await send.isEnabled()); i++) await page.waitForTimeout(250);
          if (await send.isEnabled()) {
            await send.click({ timeout: 8000 });
            record('send_code', 'clicked');
            await page.waitForTimeout(3000);
          } else {
            record('warn', 'Send Code still disabled after Turnstile wait ts=' + ts);
          }
        }
        await shot(page, 'login-code-sent');
      }
      return finish('NEEDS_EMAIL_VERIFICATION', {
        reason: 'Go Submit redirected to OTP login. Filled ' + email + '. Send Code gated by Cloudflare Turnstile (waited, no auto-token).',
        email_verification: { expected_sender_pattern: 'super-launch', expected_subject_pattern: 'verif|confirm|code|account', max_wait_minutes: 30 },
        requested_action: { action: 'other', details: 'passwordless OTP; Turnstile must produce a token before Send Code enables' },
      });
    }
    if (/payment|stripe|checkout|card number/i.test(after) && !/thank|submitted|received|review/i.test(after)) {
      return finish('NEEDS_PAYMENT', { reason: 'payment required to complete submission', requested_action: { action: 'payment', details: after.slice(0, 300) } });
    }
    if (/thank|received|submitted|under review|we.?ll review|success/i.test(after) && !/get your tool discovered/i.test(after.slice(0, 200))) {
      return finish('SUBMITTED', { confirmation_text: after.slice(0, 800), links_found: [afterUrl] });
    }
    if (/already (submitted|listed)/i.test(after)) {
      return finish('ALREADY_SUBMITTED', { confirmation_text: after.slice(0, 500) });
    }
    return finish('ERROR', { reason: `unexpected post-submit page ${afterUrl}: ${after.slice(0, 300)}` });
  } finally {
    await context.close().catch(() => {});
  }
}

await runAdapter(main);
