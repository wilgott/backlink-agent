// Adapter: Aura++
// Email/password signup. Wait for Turnstile. Never use OAuth.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  readInput, initRun, record, shot, launchBrowser, finish, runAdapter,
  missingField,
} from './lib/common.js';

const SIGNUP_URL = 'https://auraplusplus.com/sign-up';
const SUBMIT_URL = 'https://auraplusplus.com/projects/submit';

function loadOrCreateCreds(dir, email) {
  const f = path.join(dir, 'account.json');
  if (fs.existsSync(f)) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* recreate */ }
  }
  fs.mkdirSync(dir, { recursive: true });
  const creds = { email, password: crypto.randomBytes(10).toString('base64url') + 'Aa1!', created_at: new Date().toISOString() };
  fs.writeFileSync(f, JSON.stringify(creds, null, 2));
  return creds;
}

async function waitTurnstile(page) {
  for (let i = 0; i < 12; i++) {
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

async function main() {
  const { input, outputPath } = readInput();
  initRun(outputPath, input);
  const { product } = input;
  const missing = missingField(product, ['name', 'website', 'contact_email', 'founder_name']);
  if (missing) return finish('BLOCKED', { reason: 'missing required product field: ' + missing });
  const userDataDir = path.resolve(input.paths.user_data_dir || './state/profiles/aura');
  const creds = loadOrCreateCreds(userDataDir, product.contact_email);
  record('account', { email: creds.email });
  const context = await launchBrowser(input);
  const page = context.pages()[0] || (await context.newPage());
  try {
    record('goto', SIGNUP_URL);
    await page.goto(SIGNUP_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);
    await shot(page, 'signup-loaded');
    if (!(await page.getByText(/create (your )?account/i).count())) {
      const su = page.getByRole('link', { name: /sign up/i }).last();
      if (await su.count()) { await su.click(); await page.waitForTimeout(2000); }
    }
    const emailInp = page.locator('input[type="email"], input[name="email"], #email').first();
    const passInp = page.locator('input[type="password"]').first();
    if (!(await emailInp.count()) || !(await passInp.count())) {
      const body = (await page.locator('body').innerText()).slice(0, 400);
      if (/google|github/i.test(body) && !(await emailInp.count())) {
        return finish('NEEDS_OAUTH', { reason: 'OAuth-only signup UI', requested_action: { action: 'oauth_login', details: body } });
      }
      return finish('ERROR', { reason: 'email/password not found. body=' + body });
    }
    const nameInp = page.locator('input[name="name"], #name').first();
    if (await nameInp.count()) await nameInp.fill(product.founder_name);
    const firstInp = page.getByPlaceholder(/first name/i).first();
    if (await firstInp.count()) {
      const parts = (product.founder_name || '').split(' ');
      await firstInp.fill(parts[0] || '');
      const lastInp = page.getByPlaceholder(/last name/i).first();
      if (await lastInp.count()) await lastInp.fill(parts.slice(1).join(' '));
    }
    await emailInp.fill(creds.email);
    await passInp.fill(creds.password);
    await waitTurnstile(page);
    await shot(page, 'signup-filled');
    if (input.dry_run) return finish('DRY_RUN', { reason: 'dry_run: signup filled, stopped before Create account' });
    const submit = page.getByRole('button', { name: /create account|sign up|join|register/i }).first();
    if (!(await submit.count())) return finish('ERROR', { reason: 'no create-account button' });
    await submit.click({ timeout: 8000 });
    await page.waitForTimeout(5000);
    await shot(page, 'after-signup');
    const after = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    const afterUrl = page.url();
    record('after_signup', { afterUrl, after: after.slice(0, 600) });
    if (/verify your email|check your (inbox|email)|confirmation (link|email)|we sent (you )?a|enter (the )?code/i.test(after)) {
      return finish('NEEDS_EMAIL_VERIFICATION', {
        reason: 'Aura++ requires email verification',
        email_verification: { expected_sender_pattern: 'aura', expected_subject_pattern: 'verif|confirm|code', max_wait_minutes: 30 },
      });
    }
    await page.goto(SUBMIT_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2500);
    await shot(page, 'submit-page');
    const sub = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    if (/sign[- ]?in|log in|create (your )?account/i.test(page.url() + ' ' + sub.slice(0, 200))) {
      return finish('NEEDS_EMAIL_VERIFICATION', {
        reason: 'Aura++ still on auth after signup (likely email verify)',
        email_verification: { expected_sender_pattern: 'aura', expected_subject_pattern: 'verif|confirm', max_wait_minutes: 30 },
      });
    }
    return finish('ERROR', { reason: 'registered but product wizard not completed this run. url=' + page.url() + ' body=' + sub.slice(0, 250) });
  } finally {
    await context.close().catch(() => {});
  }
}
await runAdapter(main);
