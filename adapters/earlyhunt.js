// Adapter: EarlyHunt. /submit redirects to email magic-link sign-in.
// Use email Send Link only. Never Google/GitHub OAuth. Never pay.

import {
  readInput, initRun, record, shot, launchBrowser, finish, runAdapter,
  missingField,
} from './lib/common.js';

const DEFAULT_URL = 'https://earlyhunt.com/submit';

async function main() {
  const { input, outputPath } = readInput();
  initRun(outputPath, input);
  const { product } = input;
  const url = (input.site && input.site.submission_url) || DEFAULT_URL;
  const missing = missingField(product, ['name', 'website', 'contact_email']);
  if (missing) return finish('BLOCKED', { reason: 'missing required product field: ' + missing });

  const context = await launchBrowser(input);
  const page = context.pages()[0] || (await context.newPage());
  try {
    record('goto', url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);
    await shot(page, 'loaded');

    const email = page.locator('input[type=email]').first();
    if (!(await email.count())) {
      return finish('ERROR', { reason: 'no email field on ' + page.url() });
    }
    await email.click();
    await email.fill('');
    await email.pressSequentially(product.contact_email, { delay: 30 });
    await shot(page, 'email-filled');
    if (input.dry_run) {
      return finish('DRY_RUN', { reason: 'dry_run: sign-in email filled, stopped before Send Link' });
    }
    const send = page.getByRole('button', { name: /send link/i }).first();
    if (!(await send.count())) return finish('ERROR', { reason: 'Send Link button not found; did not click Google/GitHub' });
    await send.click({ timeout: 8000 });
    await page.waitForTimeout(3000);
    await shot(page, 'after-send-link');
    const after = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 1500);
    record('after_send', { url: page.url(), after: after.slice(0, 500) });
    return finish('NEEDS_EMAIL_VERIFICATION', {
      reason: 'EarlyHunt /submit is login-gated. Sent magic link to contact_email. Did not click Google/GitHub.',
      email_verification: { expected_sender_pattern: 'earlyhunt', expected_subject_pattern: 'sign|login|magic|link|verif', max_wait_minutes: 30 },
    });
  } finally {
    await context.close().catch(() => {});
  }
}

await runAdapter(main);
