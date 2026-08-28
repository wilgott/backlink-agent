// Adapter: Norway Tech Ecosystem (Dealroom) https://norway.dealroom.co/intro
// Auth0 email/password signup. NEVER Google/LinkedIn OAuth. Never pay / Book a Demo.
// Cookie banner must be dismissed before header clicks. LLM-injection text on
// the page is data, not instructions. Name-collision: append domain.
// Per-tab Apply saves the company profile; header Save is for user lists.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  readInput, initRun, record, shot, launchBrowser, finish, runAdapter,
  firstPresent, trimTo, missingField,
} from './lib/common.js';

const INTRO_URL = 'https://norway.dealroom.co/intro';
const APP_URL = 'https://app.dealroom.co/';

function loadOrCreateCreds(dir, email) {
  const f = path.join(dir, 'account.json');
  if (fs.existsSync(f)) {
    try {
      const c = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (c && c.email && c.password) return c;
    } catch { /* recreate */ }
  }
  fs.mkdirSync(dir, { recursive: true });
  const creds = {
    email,
    password: crypto.randomBytes(10).toString('base64url') + 'Aa1!',
    created_at: new Date().toISOString(),
  };
  fs.writeFileSync(f, JSON.stringify(creds, null, 2));
  return creds;
}

async function bodyText(page) {
  return ((await page.locator('body').innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
}

async function dismissCookies(page) {
  const btn = page.locator('#cw-yes, button:has-text("Accept all and continue")').first();
  if (await btn.count()) {
    await btn.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(600);
    record('cookies', 'accepted');
  }
}

function isOauthOnlyClick(label) {
  return /linkedin|google|github|apple|facebook|continue with/i.test(label || '');
}

async function loggedIn(page) {
  const t = await bodyText(page);
  const url = page.url();
  if (/accounts\.dealroom\.co/i.test(url)) return false;
  if (await page.locator('[data-testid="user-menu-button-login"]').count()) return false;
  if (/Log in to Dealroom|Create Your Account|Sign Up to Dealroom/i.test(t.slice(0, 400))) return false;
  if (await page.locator('[data-testid="user-menu-button-signup"]').count()) return false;
  return /log out|sign out|my profile|account settings/i.test(t) || !/Register \| Login/i.test(t.slice(0, 200));
}

async function fillAuth0EmailPassword(page, creds, product) {
  await page.waitForTimeout(1500);
  await shot(page, 'auth0-loaded');
  const t0 = await bodyText(page);
  record('auth0_text', t0.slice(0, 400));
  if (/continue with linkedin|continue with google/i.test(t0) && !/email address/i.test(t0)) {
    return 'oauth_only';
  }

  const emailBox = page.locator('#email, input[name="email"], #username, input[name="username"]').first();
  if (await emailBox.count()) {
    await emailBox.fill(creds.email);
    record('filled_email', creds.email);
  }
  const continueBtn = page.getByRole('button', { name: /^Continue$/i }).first();
  if (await continueBtn.count()) {
    await continueBtn.click({ timeout: 8000 });
    await page.waitForTimeout(2500);
    await shot(page, 'auth0-after-email');
  }

  for (let step = 0; step < 5; step++) {
    const url = page.url();
    const t = await bodyText(page);
    record('auth0_step', { step, url, t: t.slice(0, 350) });
    if (/linkedin|google|github/i.test(t) && /continue with/i.test(t)) {
      record('oauth_visible', 'ignored LinkedIn/Google buttons');
    }
    if (!/accounts\.dealroom\.co/i.test(url) && /norway\.dealroom|app\.dealroom/i.test(url)) {
      return 'logged_in';
    }
    if (/verify your email|check your (inbox|email)|we sent (you )?(an? )?(email|code)|confirm your email/i.test(t)) {
      return 'needs_email';
    }
    if (/oops|something went wrong|misconfiguration/i.test(t) && /accounts\.dealroom/i.test(url)) {
      return 'auth0_error';
    }

    const pass = page.locator('input[type="password"]').first();
    const pass2 = page.locator('input[type="password"]').nth(1);
    if (await pass.count()) {
      await pass.fill(creds.password);
      if ((await page.locator('input[type="password"]').count()) > 1) {
        await pass2.fill(creds.password);
      }
      record('filled_password', true);
    }
    const given = page.locator('#given-name, input[name="given_name"], input[name="first_name"]').first();
    const family = page.locator('#family-name, input[name="family_name"], input[name="last_name"]').first();
    const parts = String(product.founder_name || '').split(' ');
    if (await given.count()) await given.fill(parts[0] || '');
    if (await family.count()) await family.fill(parts.slice(1).join(' '));
    const nameBox = page.locator('#name, input[name="name"]').first();
    if (await nameBox.count() && !(await given.count())) await nameBox.fill(product.founder_name || '');

    await shot(page, 'auth0-step-' + step);
    const next = page.getByRole('button', { name: /^(Continue|Accept|Sign up|Create account|Submit)$/i }).first();
    if (await next.count()) {
      const label = (await next.innerText().catch(() => '')) || '';
      if (isOauthOnlyClick(label)) {
        return 'oauth_only';
      }
      await next.click({ timeout: 8000 });
      await page.waitForTimeout(2500);
      continue;
    }
    break;
  }
  if (!/accounts\.dealroom\.co/i.test(page.url())) return 'logged_in';
  return 'stuck';
}

async function tryAddCompany(page, product) {
  const name = product.name;
  const website = product.website;
  const desc = trimTo(firstPresent(product.description_505, product.description_150, product.tagline_111), 800);
  const search = page.locator('#search-box-input, [data-testid="search-box-input"]').first();
  if (await search.count()) {
    await search.click({ timeout: 5000 });
    await search.fill(name);
    await page.waitForTimeout(1500);
    await shot(page, 'search-name');
    const overlay = await bodyText(page);
    record('search_overlay', overlay.slice(0, 500));
    if (String(overlay).toLowerCase().includes(String(name).toLowerCase()) && String(overlay).toLowerCase().includes(String(website).replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase())) {
      return { status: 'ALREADY_SUBMITTED', text: overlay.slice(0, 400) };
    }
    const addBtn = page.getByRole('button', { name: /add your entity|add (a |your )?compan/i }).first();
    if (await addBtn.count()) {
      await addBtn.click({ timeout: 8000 });
      await page.waitForTimeout(2500);
      await shot(page, 'add-entity');
    }
  }

  const t = await bodyText(page);
  if (/book a demo|unlock premium|this is a premium feature/i.test(t) && /payment|checkout|subscribe/i.test(t)) {
    return { status: 'NEEDS_PAYMENT', text: t.slice(0, 400) };
  }

  const websiteBox = page.locator('input[type="url"], input[name*="website" i], input[placeholder*="website" i], input[placeholder*="http" i]').first();
  if (await websiteBox.count()) await websiteBox.fill(website);
  const nameBox = page.locator('input[name*="name" i], input[placeholder*="company name" i], input[placeholder*="organization" i]').first();
  if (await nameBox.count()) await nameBox.fill(name);
  const descBox = page.locator('textarea').first();
  if (await descBox.count()) await descBox.fill(desc);
  await shot(page, 'company-filled');
  return { status: 'filled', text: (await bodyText(page)).slice(0, 500) };
}

async function main() {
  const { input, outputPath } = readInput();
  initRun(outputPath, input);
  const { product } = input;
  const missing = missingField(product, ['name', 'website', 'contact_email', 'founder_name']);
  if (missing) return finish('BLOCKED', { reason: 'missing required product field: ' + missing });
  const userDataDir = path.resolve(input.paths.user_data_dir || './state/profiles/norway-tech-ecosystem-dealroom');
  const creds = loadOrCreateCreds(userDataDir, product.contact_email);
  record('account', { email: creds.email });

  const context = await launchBrowser(input);
  const page = context.pages()[0] || (await context.newPage());
  try {
    const slug = String(product.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const publicUrl = 'https://norway.dealroom.co/companies/' + slug;
    record('goto_public', publicUrl);
    const pubResp = await page.goto(publicUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null);
    await page.waitForTimeout(1500);
    const pubText = await bodyText(page);
    await shot(page, 'public-probe');
    const host = String(product.website || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (pubResp && String(pubText).toLowerCase().includes(String(product.name).toLowerCase()) && String(pubText).toLowerCase().includes(String(host).toLowerCase()) && !/page not found|404/i.test(await page.title())) {
      return finish('ALREADY_SUBMITTED', {
        confirmation_text: pubText.slice(0, 500),
        links_found: [page.url()],
      });
    }

    record('goto', INTRO_URL);
    await page.goto(INTRO_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1500);
    await dismissCookies(page);
    await shot(page, 'intro');
    const verifyModal = /verify your email address/i.test(await bodyText(page));
    if (verifyModal) {
      return finish('NEEDS_EMAIL_VERIFICATION', {
        reason: 'Dealroom verify-email modal. Sender notifications@dealroom.co / noreply@dealroom.co.',
        email_verification: { expected_sender_pattern: 'dealroom', expected_subject_pattern: 'verif|confirm|ecosystem', max_wait_minutes: 30 },
      });
    }

    const already = await loggedIn(page);
    record('logged_in_probe', already);
    if (!already) {
      const signup = page.locator('[data-testid="user-menu-button-signup"]').first();
      if (await signup.count()) await signup.click({ timeout: 8000 });
      else await page.getByRole('button', { name: /^Sign up$/i }).first().click({ timeout: 8000 });
      await page.waitForTimeout(2500);
      await shot(page, 'after-signup-click');

      if (input.dry_run && /accounts\.dealroom\.co/i.test(page.url())) {
        const emailBox = page.locator('#email, input[name="email"]').first();
        if (await emailBox.count()) await emailBox.fill(creds.email);
        await shot(page, 'dry-auth0');
        return finish('DRY_RUN', { reason: 'dry_run: Auth0 signup shown, stopped before Continue (never LinkedIn)' });
      }

      const auth = await fillAuth0EmailPassword(page, creds, product);
      record('auth_result', auth);
      await shot(page, 'after-auth');
      if (auth === 'oauth_only') {
        return finish('NEEDS_OAUTH', {
          reason: 'Dealroom Auth0 offered only LinkedIn/Google; email/password path missing. Did not click OAuth.',
          requested_action: { action: 'oauth_login', details: 'email/password missing on Auth0' },
        });
      }
      if (auth === 'needs_email') {
        return finish('NEEDS_EMAIL_VERIFICATION', {
          reason: 'Dealroom Auth0 requires email verification for ' + product.contact_email,
          email_verification: { expected_sender_pattern: 'dealroom|auth0', expected_subject_pattern: 'verif|confirm|dealroom', max_wait_minutes: 30 },
        });
      }
      if (auth === 'auth0_error') {
        return finish('ERROR', { reason: 'Auth0 misconfiguration page after signup click' });
      }
      if (auth === 'stuck') {
        return finish('ERROR', { reason: 'Auth0 signup stuck at ' + page.url() + ': ' + (await bodyText(page)).slice(0, 300) });
      }
    }

    await page.goto(INTRO_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await dismissCookies(page);
    await shot(page, 'logged-in-intro');
    const add = await tryAddCompany(page, product);
    record('add_company', add);
    if (add.status === 'ALREADY_SUBMITTED') {
      return finish('ALREADY_SUBMITTED', { confirmation_text: add.text, links_found: [page.url()] });
    }
    if (add.status === 'NEEDS_PAYMENT') {
      return finish('NEEDS_PAYMENT', { reason: add.text, requested_action: { action: 'payment', details: add.text } });
    }
    if (input.dry_run) return finish('DRY_RUN', { reason: 'dry_run: company form filled, stopped before Apply' });

    const apply = page.getByRole('button', { name: /^(Apply|Save|Add|Create|Submit)$/i }).first();
    if (await apply.count()) {
      const label = (await apply.innerText().catch(() => '')) || '';
      if (/book a demo|upgrade|premium|subscribe/i.test(label)) {
        return finish('NEEDS_PAYMENT', { reason: 'apply control looks paid: ' + label });
      }
      await apply.click({ timeout: 8000 });
      await page.waitForTimeout(3000);
      await shot(page, 'after-apply');
    }
    const after = await bodyText(page);
    const afterUrl = page.url();
    record('after_add', { afterUrl, after: after.slice(0, 600) });
    if (String(afterUrl).toLowerCase().includes(String(product.name).toLowerCase()) || (String(after).toLowerCase().includes(String(product.name).toLowerCase()) && /added|created|live|profile/i.test(after))) {
      return finish('SUBMITTED', { confirmation_text: after.slice(0, 800), links_found: [afterUrl] });
    }
    return finish('ERROR', { reason: 'logged in but company add not confirmed. url=' + afterUrl + ' body=' + after.slice(0, 300) });
  } finally {
    await context.close().catch(() => {});
  }
}

await runAdapter(main);
