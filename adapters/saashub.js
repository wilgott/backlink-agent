// Adapter: SaaSHub (https://www.saashub.com/services/submit)
// Guest URL form is a dead end ("Please register to submit more than one
// product"). Register is email/username/password + VISIBLE hCaptcha.
// Never OAuth. Never pay "Feature My Product". Never solve captchas.
// Tight SUBMITTED detector: marketing copy "all submitted products go through
// an approval process" is NOT confirmation.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  readInput, initRun, record, shot, launchBrowser, finish, runAdapter,
  firstPresent, missingField,
} from './lib/common.js';

const SUBMIT_URL = 'https://www.saashub.com/services/submit';
const REGISTER_URL = 'https://www.saashub.com/register';
const LOGIN_URL = 'https://www.saashub.com/login';

function slugUsername(email, productName) {
  const fromName = String(productName || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20);
  const fromEmail = String(email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20);
  return fromName || fromEmail || 'user';
}

function loadOrCreateCreds(dir, email, productName) {
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
    username: slugUsername(email, productName),
    password: crypto.randomBytes(10).toString('base64url') + 'Aa1!',
    created_at: new Date().toISOString(),
  };
  fs.writeFileSync(f, JSON.stringify(creds, null, 2));
  return creds;
}

async function bodyText(page) {
  return ((await page.locator('body').innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
}

async function visibleChallenge(page) {
  return await page.evaluate(() => {
    const sels = [
      'iframe[src*="hcaptcha"]',
      'iframe[src*="recaptcha"]',
      'iframe[src*="challenges.cloudflare"]',
      'iframe[title*="hCaptcha"]',
      'iframe[title*="reCAPTCHA"]',
      '.h-captcha iframe',
      '.g-recaptcha iframe',
      '.cf-turnstile iframe',
    ];
    for (const sel of sels) {
      for (const f of document.querySelectorAll(sel)) {
        const r = f.getBoundingClientRect();
        if (r.width > 80 && r.height > 40 && r.bottom > 0 && r.top < innerHeight) {
          return (f.src || f.title || sel).slice(0, 120);
        }
      }
    }
    const widget = document.querySelector('.h-captcha, [data-hcaptcha-widget-id], .cf-turnstile');
    if (widget) {
      const r = widget.getBoundingClientRect();
      if (r.width > 80 && r.height > 40) return 'visible-widget';
    }
    return '';
  });
}

function isRealConfirmation(url, text) {
  // Guideline copy on the submit page is not confirmation.
  if (/\/services\/submit/i.test(url) && /please register to submit more than one/i.test(text)) return false;
  if (/all submitted products go through an approval process/i.test(text) && /\/services\/submit/i.test(url)) return false;
  if (/thank you for (your )?submi|your (product|listing) (has been|was) (submitted|received)|we (have )?received your (product|submission)|submission (received|successful)/i.test(text)
      && !/please register to submit more than one/i.test(text)) {
    return true;
  }
  return false;
}

async function main() {
  const { input, outputPath } = readInput();
  initRun(outputPath, input);
  const { product } = input;
  const missing = missingField(product, ['name', 'website', 'contact_email']);
  if (missing) return finish('BLOCKED', { reason: 'missing required product field: ' + missing });
  const userDataDir = path.resolve(input.paths.user_data_dir || './state/profiles/saashub');
  const creds = loadOrCreateCreds(userDataDir, product.contact_email, product.name);
  record('account', { email: creds.email, username: creds.username });

  const context = await launchBrowser(input);
  const page = context.pages()[0] || (await context.newPage());
  try {
    record('goto', SUBMIT_URL);
    await page.goto(SUBMIT_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);
    await shot(page, 'submit-loaded');
    let t = await bodyText(page);
    const headerAuth = /Register\s*\|\s*Login/i.test(t.slice(0, 400));
    record('auth_probe', { headerAuth, url: page.url() });

    if (headerAuth) {
      record('goto_register', REGISTER_URL);
      await page.goto(REGISTER_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2000);
      await shot(page, 'register-loaded');

      const challenge = await visibleChallenge(page);
      record('captcha_visible', challenge || 'none');
      if (challenge) {
        return finish('CAPTCHA_UNSOLVABLE', {
          reason: 'SaaSHub register shows a visible hCaptcha/reCAPTCHA widget. Did not click I-am-human, did not OAuth, did not pay. Guest submit is not a listing.',
        });
      }

      await page.locator('#user_email').fill(creds.email);
      await page.locator('#user_username').fill(creds.username);
      await page.locator('#user_password').fill(creds.password);
      await page.locator('#user_password_confirmation').fill(creds.password);
      const weekly = page.locator('#tribune_weekly');
      if (await weekly.count()) {
        if (await weekly.isChecked()) await weekly.uncheck().catch(() => {});
      }
      // honeypot #company_name "Do not input this" — leave empty
      await shot(page, 'register-filled');
      if (input.dry_run) return finish('DRY_RUN', { reason: 'dry_run: register filled, stopped before Register click' });

      const challenge2 = await visibleChallenge(page);
      if (challenge2) {
        return finish('CAPTCHA_UNSOLVABLE', { reason: 'visible captcha appeared after fill: ' + challenge2 });
      }
      await page.locator('input[type="submit"][name="commit"]').first().click({ timeout: 8000 });
      await page.waitForTimeout(4000);
      await shot(page, 'after-register');
      const after = await bodyText(page);
      record('after_register', { url: page.url(), after: after.slice(0, 600) });
      if (/check your (inbox|email)|confirm your email|verification/i.test(after)) {
        return finish('NEEDS_EMAIL_VERIFICATION', {
          reason: 'SaaSHub sent an email confirmation after register',
          email_verification: { expected_sender_pattern: 'saashub', expected_subject_pattern: 'confirm|verif|welcome', max_wait_minutes: 30 },
        });
      }
      return finish('ERROR', { reason: 'register posted without captcha but unexpected page ' + page.url() + ': ' + after.slice(0, 300) });
    }

    // Logged in (or guest form without the register|login header). Fill URL.
    const urlBox = page.locator('input[name="url"]').first();
    if (!(await urlBox.count())) return finish('ERROR', { reason: 'url input not found on submit' });
    await urlBox.fill(product.website);
    record('filled_url', product.website);
    const tagline = firstPresent(product.tagline_50, product.tagline_111, product.description_145);
    record('tagline_ready', tagline.slice(0, 80));
    await shot(page, 'url-filled');
    if (input.dry_run) return finish('DRY_RUN', { reason: 'dry_run: URL filled, stopped before commit' });

    const commit = page.locator('form').filter({ has: page.locator('input[name="url"]') }).locator('input[type="submit"][name="commit"]').first();
    if (await commit.count()) await commit.click({ timeout: 8000 });
    else await page.locator('input[type="submit"][name="commit"]').first().click({ timeout: 8000 });
    await page.waitForTimeout(4000);
    await shot(page, 'after-url-submit');
    const afterUrl = page.url();
    const after = (await bodyText(page)).slice(0, 2500);
    record('after_url', { afterUrl, after: after.slice(0, 700) });

    if (isRealConfirmation(afterUrl, after)) {
      return finish('SUBMITTED', { confirmation_text: after.slice(0, 800), links_found: [afterUrl] });
    }
    if (/already (listed|exists|submitted)/i.test(after) && !/\/services\/submit/i.test(afterUrl)) {
      return finish('ALREADY_SUBMITTED', { confirmation_text: after.slice(0, 500), links_found: [afterUrl] });
    }
    if (/please register to submit more than one/i.test(after)) {
      return finish('ERROR', { reason: 'SaaSHub still asks to register after URL submit; not a listing. Did not treat guideline "submitted products" copy as confirmation.' });
    }
    if (/feature my product|sponsored|\$\d+/i.test(after) && /checkout|payment|stripe/i.test(afterUrl + after)) {
      return finish('NEEDS_PAYMENT', { reason: 'paid featuring required; never pay', requested_action: { action: 'payment', details: after.slice(0, 300) } });
    }
    return finish('ERROR', { reason: 'unexpected after URL submit ' + afterUrl + ': ' + after.slice(0, 350) });
  } finally {
    await context.close().catch(() => {});
  }
}

await runAdapter(main);
