// Adapter: Firsto (https://firsto.co/projects/submit)
// Open-Launch fork. Email/password login with stored account.json.
// Never create a new account if creds exist. Never OAuth. Never pay.
// Free-path 4-step wizard: Project Info -> Details -> Launch Date -> Review.
//
// Contract: docs/ADAPTER_CONTRACT.md

import fs from 'node:fs';
import path from 'node:path';
import {
  readInput, initRun, record, shot, launchBrowser, finish, runAdapter,
  firstPresent, missingField, detectCaptcha,
} from './lib/common.js';

const LOGIN_URL = 'https://firsto.co/sign-in';
const SUBMIT_URL = 'https://firsto.co/projects/submit';
const DASHBOARD_URL = 'https://firsto.co/dashboard';

const WANTED_CATEGORIES = [
  /data science|analytics/i,
  /productivity/i,
  /testing|qa/i,
  /saas/i,
  /marketing/i,
  /developer/i,
  /seo/i,
  /lifestyle/i,
  /cms|no-?code/i,
];
const TECH_STACK = ['screenshots', 'monitoring', 'saas', 'visual-diffs', 'alerts'];

function loadStoredCreds(dir) {
  const f = path.join(dir, 'account.json');
  if (!fs.existsSync(f)) return null;
  try {
    const creds = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (creds && creds.email && creds.password) return creds;
  } catch { /* ignore */ }
  return null;
}

async function bodyText(page) {
  return ((await page.locator('body').innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
}

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

function isAuthUrl(url) {
  return /sign-in|sign-up|login|verify-email/i.test(url);
}

async function onSubmitForm(page) {
  const url = page.url();
  if (/\/projects\/submit/i.test(url) && !isAuthUrl(url)) return true;
  const t = await bodyText(page);
  return /submit a project|project name/i.test(t) && !/welcome back|create (an |your )?account/i.test(t.slice(0, 250));
}

async function dumpFields(page, label) {
  const dump = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input, textarea, [contenteditable="true"]')].map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      name: el.getAttribute('name') || '',
      id: el.id || '',
      ph: el.getAttribute('placeholder') || '',
      label: (el.labels && el.labels[0] && el.labels[0].innerText) || '',
    })).slice(0, 40);
    const buttons = [...document.querySelectorAll('button,[role="button"]')]
      .map((e) => (e.innerText || '').trim().slice(0, 80))
      .filter(Boolean)
      .slice(0, 40);
    const checks = [...document.querySelectorAll('label')].map((l) => (l.innerText || '').trim().slice(0, 80)).filter(Boolean).slice(0, 80);
    return { url: location.href, inputs, buttons, checks };
  });
  record('dump_' + label, dump);
  return dump;
}

async function fillRichText(page, text) {
  const ed = page.locator('.ProseMirror, [contenteditable="true"]').first();
  if (!(await ed.count())) return false;
  await ed.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(200);
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.press('Meta+A').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  // TipTap stores HTML; typing is enough to fire onUpdate.
  await ed.fill(text).catch(async () => {
    await page.keyboard.type(text, { delay: 2 });
  });
  await page.waitForTimeout(300);
  return true;
}

async function uploadFirstFile(page, filePath, kind) {
  const files = page.locator('input[type="file"]');
  const n = await files.count();
  record('file_inputs', { kind, n });
  if (!n) return false;
  const idx = kind === 'product' && n > 1 ? 1 : 0;
  await files.nth(idx).setInputFiles(filePath);
  record('uploaded', { kind, filePath, idx });
  for (let i = 0; i < 20; i++) {
    const t = await bodyText(page);
    if (/upload failed|failed: no url/i.test(t)) return false;
    if (kind === 'logo' && (/logo preview|uploaded logo/i.test(t) || await page.locator('img[alt*="ogo" i]').count())) {
      await page.waitForTimeout(400);
      return true;
    }
    if (kind === 'product' && await page.locator('img[alt*="roduct" i]').count()) {
      await page.waitForTimeout(400);
      return true;
    }
    // UploadThing often shows a spinner then a preview image near the button
    if (i > 3 && await page.locator('img[src*="utfs"], img[src*="uploadthing"], img[src*="assert.firsto"], img[src*="ufs.sh"]').count()) {
      return true;
    }
    await page.waitForTimeout(500);
  }
  // accept as uploaded if file input is gone / preview exists
  return (await page.locator('img[alt*="ogo" i], img[alt*="roduct" i], img[src*="utfs"], img[src*="assert.firsto"]').count()) > 0;
}

async function clickNext(page) {
  const next = page.getByRole('button', { name: /^next$/i }).first();
  if (!(await next.count())) return false;
  await next.scrollIntoViewIfNeeded().catch(() => {});
  await next.click({ timeout: 8000 });
  await page.waitForTimeout(1500);
  return true;
}

async function pickCategories(page, maxN = 3) {
  const picked = [];
  const labels = page.locator('label');
  const n = await labels.count();
  const texts = [];
  for (let i = 0; i < Math.min(n, 200); i++) {
    texts.push(((await labels.nth(i).innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim());
  }
  record('category_labels', texts.filter((t) => t && t.length < 60).slice(0, 80));
  for (const re of WANTED_CATEGORIES) {
    if (picked.length >= maxN) break;
    const idx = texts.findIndex((t, i) => t && re.test(t) && !picked.includes(i));
    if (idx >= 0) {
      await labels.nth(idx).click({ timeout: 3000 }).catch(() => {});
      picked.push(idx);
      record('picked_category', texts[idx]);
      await page.waitForTimeout(150);
    }
  }
  if (!picked.length) {
    // first few non-empty checkbox labels
    for (let i = 0; i < texts.length && picked.length < 2; i++) {
      if (texts[i] && texts[i].length < 40 && !/categor/i.test(texts[i])) {
        await labels.nth(i).click({ timeout: 3000 }).catch(() => {});
        picked.push(i);
        record('picked_category_fallback', texts[i]);
      }
    }
  }
  return picked.map((i) => texts[i]);
}

async function findListingOnDashboard(page, product) {
  await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await shot(page, 'dashboard');
  const found = await page.evaluate((want) => {
    const name = (want.name || '').toLowerCase();
    const host = (want.website || '').replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
    const links = [...document.querySelectorAll('a')];
    for (const a of links) {
      const href = a.href || '';
      const t = ((a.innerText || '') + ' ' + (a.closest('article,div,li,section')?.innerText || '')).toLowerCase();
      if (/\/projects\/[a-z0-9-]+/i.test(href) && !/\/projects\/submit/i.test(href) && (t.includes(name) || t.includes(host))) {
        return href.split('?')[0];
      }
    }
    return null;
  }, { name: product.name, website: product.website });
  record('dashboard_listing', found);
  return found;
}

async function loginWithCreds(page, creds) {
  record('goto_login', LOGIN_URL);
  const cur = page.url();
  if (!/sign-in/i.test(cur)) {
    await page.goto(LOGIN_URL + '?redirect=/projects/submit', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);
  }
  await shot(page, 'login-loaded');

  // Never click Google / GitHub
  const emailInp = page.locator('input[type="email"], input[name="email"], #email').first();
  const passInp = page.locator('input[type="password"]').first();
  if (!(await emailInp.count()) || !(await passInp.count())) {
    const body = (await bodyText(page)).slice(0, 400);
    return { ok: false, status: 'ERROR', reason: 'email/password fields not found on Firsto sign-in. body=' + body };
  }
  await emailInp.fill(creds.email);
  await passInp.fill(creds.password);
  record('login_filled', { email: creds.email });

  const captcha = await detectCaptcha(page);
  const visibleTs = /verify you are human|cf-turnstile|protected by cloudflare/i.test(await bodyText(page))
    || (await page.locator('iframe[src*="challenges.cloudflare"], iframe[src*="turnstile"], .cf-turnstile, [data-sitekey]').count()) > 0;
  record('captcha_kind', { detect: captcha, visibleTs });
  const tok = await waitTurnstile(page, 20);
  await shot(page, 'login-filled');

  const loginBtn = page.getByRole('button', { name: /^(login|log in|sign in)$/i }).first();
  if (!(await loginBtn.count())) {
    return { ok: false, status: 'ERROR', reason: 'no Login button on Firsto sign-in' };
  }
  const enabled = await loginBtn.isEnabled().catch(() => false);
  if (!tok || !enabled || visibleTs && !tok) {
    await shot(page, 'login-captcha-blocked');
    return {
      ok: false,
      status: 'CAPTCHA_UNSOLVABLE',
      reason: 'NEEDS_CAPTCHA: Cloudflare Turnstile on Firsto sign-in ("Verify you are human"). Login stayed disabled; no cf-turnstile-response after 20s. Did not solve. Did not click Google/GitHub. Exact copy: "Verify you are human".',
    };
  }
  await loginBtn.click({ timeout: 8000 });
  await page.waitForTimeout(5000);
  await shot(page, 'after-login');
  const afterUrl = page.url();
  const after = await bodyText(page);
  record('after_login', { afterUrl, after: after.slice(0, 600) });

  if (/please complete the security verification/i.test(after)) {
    return {
      ok: false,
      status: 'CAPTCHA_UNSOLVABLE',
      reason: 'NEEDS_CAPTCHA: Firsto sign-in: "Please complete the security verification". Turnstile blocked Login. Exact copy on page.',
    };
  }
  if (/verify your email|check your (inbox|email)|we('ve| have) sent you a verification/i.test(after) || /verify-email/i.test(afterUrl)) {
    return {
      ok: false,
      status: 'NEEDS_EMAIL_VERIFICATION',
      reason: 'Firsto still requires email verification after login. url=' + afterUrl,
    };
  }
  if (/invalid (email|password)|incorrect password|invalid credentials|account (not found|does not exist)/i.test(after) && isAuthUrl(afterUrl)) {
    return { ok: false, status: 'ERROR', reason: 'Firsto login rejected stored creds. copy=' + after.slice(0, 250) };
  }
  if (isAuthUrl(afterUrl) && /welcome back|sign in to your account|create an account/i.test(after.slice(0, 300))) {
    // maybe still spinning
    await page.waitForTimeout(4000);
    if (isAuthUrl(page.url())) {
      return {
        ok: false,
        status: captcha ? 'CAPTCHA_UNSOLVABLE' : 'ERROR',
        reason: (captcha ? 'NEEDS_CAPTCHA: still on sign-in after Login (Turnstile likely). ' : 'still on sign-in after Login. ')
          + 'url=' + page.url() + ' body=' + (await bodyText(page)).slice(0, 300),
      };
    }
  }
  return { ok: true };
}

async function main() {
  const { input, outputPath } = readInput();
  initRun(outputPath, input);
  const { product } = input;
  const missing = missingField(product, ['name', 'website', 'founder_name']);
  if (missing) return finish('BLOCKED', { reason: 'missing required product field: ' + missing });

  const userDataDir = path.resolve(input.paths.user_data_dir || './state/profiles/firsto');
  const creds = loadStoredCreds(userDataDir);
  if (!creds) {
    return finish('ERROR', { reason: 'no stored Firsto account.json; refusing to create a new account' });
  }
  record('account', { email: creds.email, source: 'account.json' });

  const tagline = firstPresent(product.tagline_111, product.tagline_50, product.tagline_39);
  const description = firstPresent(product.description_505, product.description_150, product.description_145, tagline);
  const logoPath = product.logo ? path.resolve(product.logo) : null;
  const shotPath = (product.screenshots || []).map((p) => path.resolve(p)).find((p) => fs.existsSync(p)) || null;
  if (!logoPath || !fs.existsSync(logoPath)) {
    return finish('BLOCKED', { reason: 'logo file missing (Firsto step 1 requires logo)' });
  }

  const context = await launchBrowser(input);
  const page = context.pages()[0] || (await context.newPage());
  try {
    // 1) Try submit page — session may already be in the app.
    record('goto', SUBMIT_URL);
    await page.goto(SUBMIT_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);
    await shot(page, 'submit-or-auth');
    let loggedIn = await onSubmitForm(page);
    record('session', { loggedIn, url: page.url() });

    if (!loggedIn) {
      const url = page.url();
      const t = await bodyText(page);
      if (/verify-email/i.test(url) || /verify your email|we('ve| have) sent you a verification/i.test(t)) {
        return finish('NEEDS_EMAIL_VERIFICATION', {
          reason: 'Firsto session still on verify-email. url=' + url,
          email_verification: { expected_sender_pattern: 'firsto', expected_subject_pattern: 'verif|confirm', max_wait_minutes: 30 },
        });
      }
      const login = await loginWithCreds(page, creds);
      if (!login.ok) {
        if (login.status === 'CAPTCHA_UNSOLVABLE') {
          return finish('CAPTCHA_UNSOLVABLE', { reason: login.reason });
        }
        if (login.status === 'NEEDS_EMAIL_VERIFICATION') {
          return finish('NEEDS_EMAIL_VERIFICATION', {
            reason: login.reason,
            email_verification: { expected_sender_pattern: 'firsto', expected_subject_pattern: 'verif|confirm', max_wait_minutes: 30 },
          });
        }
        return finish('ERROR', { reason: login.reason });
      }
      record('login', 'ok');
      if (!(await onSubmitForm(page))) {
        await page.goto(SUBMIT_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(2500);
      }
      await shot(page, 'submit-after-login');
      loggedIn = await onSubmitForm(page);
    }

    if (!loggedIn) {
      const url = page.url();
      const t = await bodyText(page);
      if (/verify-email/i.test(url)) {
        return finish('NEEDS_EMAIL_VERIFICATION', { reason: 'after login still verify-email ' + url });
      }
      if (isAuthUrl(url)) {
        return finish('ERROR', { reason: 'login appeared to succeed but still on auth. url=' + url + ' body=' + t.slice(0, 300) });
      }
      return finish('ERROR', { reason: 'not on submit form after login. url=' + url + ' body=' + t.slice(0, 300) });
    }
    record('in_app', page.url());

    // Already listed? dashboard first, then check-url.
    const existing = await findListingOnDashboard(page, product);
    if (existing) {
      await shot(page, 'already-listed');
      return finish('ALREADY_SUBMITTED', {
        reason: product.name + ' already on Firsto dashboard',
        confirmation_text: existing,
        links_found: [existing],
      });
    }
    const urlExists = await page.evaluate(async (website) => {
      try {
        const r = await fetch('/api/projects/check-url?url=' + encodeURIComponent(website));
        const data = await r.json();
        return data;
      } catch (e) {
        return { error: String(e) };
      }
    }, product.website);
    record('check_url', urlExists);
    if (urlExists && urlExists.exists) {
      // listed but dashboard didn't show a public URL — do not invent one
      await page.goto(SUBMIT_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      return finish('ALREADY_SUBMITTED', {
        reason: 'Firsto check-url reports website already submitted; no public listing URL found on dashboard',
        links_found: [],
      });
    }

    await page.goto(SUBMIT_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);
    await shot(page, 'form-loaded');
    await dumpFields(page, 'step1');

    // ----- Step 1: name, url, description, logo -----
    const nameInp = page.locator('#name, input[name="name"]').first();
    if (await nameInp.count()) await nameInp.fill(product.name);
    else await page.getByLabel(/project name/i).first().fill(product.name);

    const urlInp = page.locator('#websiteUrl, input[name="websiteUrl"], input[type="url"]').first();
    if (await urlInp.count()) await urlInp.fill(product.website);
    else await page.getByLabel(/website url/i).first().fill(product.website);

    const richOk = await fillRichText(page, description);
    if (!richOk) {
      const ta = page.locator('textarea, #description').first();
      if (await ta.count()) await ta.fill(description);
    }
    record('step1_text', { name: product.name, website: product.website, description_chars: description.length, richOk });

    const logoOk = await uploadFirstFile(page, logoPath, 'logo');
    record('logo_upload', logoOk);
    if (shotPath) {
      const prodOk = await uploadFirstFile(page, shotPath, 'product');
      record('product_image_upload', prodOk);
    }
    await shot(page, 'step1-filled');

    if (input.dry_run) {
      return finish('DRY_RUN', { reason: 'dry_run: logged in, step 1 filled, stopped before Next' });
    }

    if (!(await clickNext(page))) return finish('ERROR', { reason: 'Next button not found on step 1' });
    await shot(page, 'step2');
    let err = (await page.locator('.text-destructive, [class*="destructive"]').first().innerText().catch(() => '')) || '';
    const t2 = await bodyText(page);
    if (/please fill in all required/i.test(t2) || /please fill in all required/i.test(err)) {
      return finish('ERROR', { reason: 'step 1 validation: ' + (err || t2.slice(0, 250)) + ' logoOk=' + logoOk });
    }

    // ----- Step 2: categories, tech, platforms, pricing -----
    await dumpFields(page, 'step2');
    const cats = await pickCategories(page, 3);
    record('categories', cats);

    const techInp = page.getByPlaceholder(/technology|tech stack|press enter/i).first();
    if (await techInp.count()) {
      for (const tech of TECH_STACK.slice(0, 5)) {
        await techInp.click().catch(() => {});
        await techInp.fill(tech);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(200);
      }
    } else {
      record('warn', 'tech stack input not found');
    }

    // Platforms: prefer web
    await page.locator('label').filter({ hasText: /^web$/i }).first().click({ timeout: 3000 }).catch(() => {});
    const platWeb = page.locator('#platform-web, input[id*="platform-web"]').first();
    if (await platWeb.count()) await platWeb.check({ force: true }).catch(() => platWeb.click());

    // Pricing: free (product is free early access)
    const freePrice = page.locator('label').filter({ hasText: /^free$/i }).first();
    if (await freePrice.count()) await freePrice.click({ timeout: 3000 }).catch(() => {});
    else {
      await page.locator('#pricing-free, [id*="pricing-free"]').first().click({ timeout: 3000 }).catch(() => {});
    }

    if (product.founder_github) {
      const gh = page.locator('#githubUrl, input[name="githubUrl"]').first();
      if (await gh.count()) await gh.fill(product.founder_github);
    }
    await shot(page, 'step2-filled');

    if (!(await clickNext(page))) return finish('ERROR', { reason: 'Next button not found on step 2' });
    await page.waitForTimeout(2000);
    await shot(page, 'step3');
    const t3 = await bodyText(page);
    record('step3_text', t3.slice(0, 800));
    if (/please complete the technical|maximum of 3 categor/i.test(t3)) {
      return finish('ERROR', { reason: 'step 2 validation: ' + t3.slice(0, 300) });
    }

    // ----- Step 3: FREE launch + first available date -----
    // Never click Premium / Pro / $19.9 / $59.9
    const freeCard = page.locator('div,button,article,section,label').filter({ hasText: /free launch/i }).first();
    if (await freeCard.count()) {
      await freeCard.click({ timeout: 5000 }).catch(() => record('warn', 'could not click Free Launch card'));
    } else {
      await page.getByText(/^\$0/i).first().click({ timeout: 3000 }).catch(() => {});
    }
    await page.waitForTimeout(800);
    await shot(page, 'step3-free');

    // Wait for dates to load
    for (let i = 0; i < 15; i++) {
      const t = await bodyText(page);
      if (!/loading available dates/i.test(t)) break;
      await page.waitForTimeout(500);
    }
    const dateBody = await bodyText(page);
    if (/no available launch dates/i.test(dateBody)) {
      return finish('ERROR', { reason: 'no available free launch dates. Did not pay. copy=' + dateBody.slice(0, 300) });
    }

    const dateTrigger = page.getByRole('combobox').first();
    const dateBtn = page.getByText(/select a launch date/i).first();
    if (await dateTrigger.count()) await dateTrigger.click({ timeout: 5000 }).catch(() => {});
    else if (await dateBtn.count()) await dateBtn.click({ timeout: 5000 }).catch(() => {});
    else {
      await page.locator('[role="combobox"], button:has-text("Select a launch date")').first().click({ timeout: 5000 }).catch(() => {});
    }
    await page.waitForTimeout(600);

    const options = page.locator('[role="option"]:not([aria-disabled="true"])');
    const nOpt = await options.count();
    record('date_options', nOpt);
    if (nOpt) {
      const firstTxt = ((await options.first().innerText().catch(() => '')) || '').trim();
      record('picked_date', firstTxt);
      await options.first().click({ timeout: 5000 });
    } else {
      // maybe native select
      const sel = page.locator('select').first();
      if (await sel.count()) {
        const vals = await sel.locator('option:not([disabled])').evaluateAll((els) => els.map((e) => e.value).filter(Boolean));
        if (vals.length) await sel.selectOption(vals[0]);
        record('picked_date_select', vals[0] || null);
      } else {
        await dumpFields(page, 'no_dates');
        return finish('ERROR', { reason: 'could not open launch-date picker on free path. body=' + dateBody.slice(0, 300) });
      }
    }
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(800);
    await shot(page, 'step3-date');

    if (!(await clickNext(page))) return finish('ERROR', { reason: 'Next button not found on step 3' });
    await page.waitForTimeout(1500);
    await shot(page, 'step4-review');
    const t4 = await bodyText(page);
    record('step4_text', t4.slice(0, 800));
    if (/please select a launch date/i.test(t4)) {
      return finish('ERROR', { reason: 'step 3 validation: please select a launch date. ' + t4.slice(0, 250) });
    }

    // Badge copy is DF-eligibility, not a hard gate on Open-Launch. Record it.
    const badgeSnip = (t4.match(/display our badge[\s\S]{0,200}/i) || t4.match(/badge[\s\S]{0,160}/i) || [''])[0];
    record('badge_copy', badgeSnip.slice(0, 300));

    // ----- Step 4: Submit Project (free only) -----
    if (/premium launch|pro launch/i.test(t4) && /\$19|\$59|redirected to the payment/i.test(t4) && !/free launch/i.test(t4)) {
      return finish('NEEDS_PAYMENT', { reason: 'review step is a paid plan; refusing to submit. copy=' + t4.slice(0, 300) });
    }

    const submitBtn = page.getByRole('button', { name: /submit project/i }).first();
    if (!(await submitBtn.count())) {
      return finish('ERROR', { reason: 'Submit Project button not found on review. body=' + t4.slice(0, 300) });
    }
    record('submit', 'clicking Submit Project (free)');
    await submitBtn.click({ timeout: 8000 });

    for (let i = 0; i < 24; i++) {
      await page.waitForTimeout(1000);
      const u = page.url();
      if (/\/projects\/[a-z0-9-]+/i.test(u) && !/\/projects\/submit/i.test(u)) break;
      if (/payment|stripe|checkout/i.test(u)) break;
      const btnT = ((await submitBtn.innerText().catch(() => '')) || '');
      if (!/pending|submitting|loader/i.test(btnT) && i > 4) break;
    }
    await shot(page, 'after-submit');
    const afterUrl = page.url();
    const after = await bodyText(page);
    record('after_submit', { afterUrl, after: after.slice(0, 800) });

    if (/this website url has already been submitted/i.test(after)) {
      const again = await findListingOnDashboard(page, product);
      return finish('ALREADY_SUBMITTED', {
        reason: 'Firsto: "This website URL has already been submitted."',
        confirmation_text: after.slice(0, 400),
        links_found: again ? [again] : [],
      });
    }
    if (/stripe|checkout|client_reference_id|payment/i.test(afterUrl) || (/redirected to the payment|card number/i.test(after) && !/\/projects\//i.test(afterUrl))) {
      return finish('NEEDS_PAYMENT', { reason: 'landed on payment after submit; did not pay. url=' + afterUrl });
    }
    const listing = afterUrl.match(/https?:\/\/firsto\.co\/projects\/[a-z0-9-]+/i);
    if (listing && !/\/projects\/submit/i.test(listing[0])) {
      return finish('SUBMITTED', {
        confirmation_text: after.slice(0, 800),
        links_found: [listing[0].replace(/\/$/, '')],
      });
    }
    // slug in-page link
    const href = await page.evaluate(() => {
      const a = [...document.querySelectorAll('a')].find((x) => /\/projects\/[a-z0-9-]+/i.test(x.href) && !/submit/i.test(x.href));
      return a ? a.href.split('?')[0] : null;
    });
    if (href && /firsto\.co\/projects\//i.test(href)) {
      return finish('SUBMITTED', { confirmation_text: after.slice(0, 800), links_found: [href] });
    }
    if (/scheduled|thanks|submitted|project created|ready to launch/i.test(after) && !/submit a project/i.test(after.slice(0, 120))) {
      return finish('SUBMITTED', { confirmation_text: after.slice(0, 800), links_found: [] });
    }
    if (/verify (your )?badge|add this badge|paste this (code|snippet)/i.test(after) && /required/i.test(after)) {
      return finish('BLOCKED', {
        reason: 'NEEDS_BADGE: Firsto blocked submit pending badge embed. snippet=' + after.slice(0, 400),
        requested_action: { action: 'other', details: after.slice(0, 400) },
      });
    }
    return finish('ERROR', { reason: 'unexpected post-submit ' + afterUrl + ': ' + after.slice(0, 350) });
  } finally {
    await context.close().catch(() => {});
  }
}

await runAdapter(main);
