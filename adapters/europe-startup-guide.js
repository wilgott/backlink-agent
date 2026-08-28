// Adapter: Europe Startup Guide (https://europe-startup-guide.com/suggest)
// Public suggest form, no login, no captcha, no payment. Human review.
// Fields use ids (suggest-name etc), not name attrs. Honeypot #suggest-hp MUST stay empty.

import {
  readInput, initRun, record, shot, launchBrowser, finish, runAdapter,
  firstPresent, trimTo, missingField, detectCaptcha,
} from './lib/common.js';

const DEFAULT_URL = 'https://europe-startup-guide.com/suggest';

async function main() {
  const { input, outputPath } = readInput();
  initRun(outputPath, input);
  const { product } = input;
  const url = (input.site && input.site.submission_url) || DEFAULT_URL;
  const missing = missingField(product, ['name', 'website', 'founder_name', 'contact_email']);
  if (missing) return finish('BLOCKED', { reason: `missing required product field: ${missing}` });
  const description = trimTo(firstPresent(product.description_505, product.description_145, product.tagline_111), 7000);
  if (!description || description.length < 40) return finish('BLOCKED', { reason: 'description shorter than 40 chars' });
  const sectors = (product.categories || []).join(', ') || (product.tags || []).slice(0, 4).join(', ');

  const context = await launchBrowser(input);
  const page = context.pages()[0] || (await context.newPage());
  try {
    record('goto', url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);
    await shot(page, 'form-loaded');
    const captcha = await detectCaptcha(page);
    if (captcha) return finish('CAPTCHA_UNSOLVABLE', { reason: `visible ${captcha} on form` });

    await page.locator('#suggest-name').fill(product.name);
    await page.locator('#suggest-type').selectOption({ label: 'Startup' });
    const country = product.hq;
    if (!country) return finish('BLOCKED', { reason: 'missing product.hq for country field' });
    await page.locator('#suggest-country').selectOption({ label: country });
    // product.json has no city field; leave city blank rather than inventing one.
    await page.locator('#suggest-website').fill(product.website);
    await page.locator('#suggest-description').fill(description);
    if (sectors) await page.locator('#suggest-sectors').fill(sectors);
    await page.locator('#suggest-key-people').fill(product.founder_name + ' (Founder)');
    await page.locator('#suggest-source-links').fill(product.website);
    await page.locator('#suggest-submitter-name').fill(product.founder_name);
    await page.locator('#suggest-submitter-email').fill(product.contact_email);
    const hp = page.locator('#suggest-hp');
    if (await hp.count()) {
      const v = await hp.inputValue().catch(() => '');
      if (v) await hp.fill('');
      record('honeypot', 'left empty');
    }
    record('filled', { name: product.name, country });
    await shot(page, 'filled');

    if (input.dry_run) {
      return finish('DRY_RUN', { reason: 'dry_run: suggest form filled, stopped before Submit for review' });
    }

    const submitBtn = page.getByRole('button', { name: /submit for review|submitting/i }).first();
    await submitBtn.click({ timeout: 8000 });
    // Turnstile can appear only at submit. Wait for auto-token, then for the
    // button to leave "Submitting...". Do not solve captcha.
    for (let i = 0; i < 25; i++) {
      const tok = await page.evaluate(() => {
        const el = document.querySelector('input[name="cf-turnstile-response"]');
        return el && el.value ? el.value.slice(0, 8) : '';
      });
      const label = ((await submitBtn.innerText().catch(() => '')) || '').trim();
      const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 800);
      record('submit_wait', { i, tok: !!tok, label, hit: /thank|received|submitted|under review/i.test(body) });
      if (/thank|received|submitted|under review|suggestion (has been|was)/i.test(body) && !/submitting/i.test(label)) break;
      if (i === 0) await shot(page, 'submitting');
      await page.waitForTimeout(1500);
    }
    await shot(page, 'after-submit');
    const afterUrl = page.url();
    const after = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 2000);
    record('after_submit', { afterUrl, after: after.slice(0, 600) });

    if (/thank|received|submitted|under review|we.?ll review|suggestion (has been|was) (sent|received)/i.test(after)) {
      return finish('SUBMITTED', { confirmation_text: after.slice(0, 800), links_found: [afterUrl] });
    }
    if (/already|duplicate/i.test(after)) {
      return finish('ALREADY_SUBMITTED', { confirmation_text: after.slice(0, 500) });
    }
    if (/error|invalid|required|please (fill|enter|correct)/i.test(after) && /suggest/i.test(afterUrl)) {
      const m = after.match(/(error|invalid|required|please (fill|enter|correct))[^.!?]{0,160}/i);
      return finish('ERROR', { reason: `validation: ${m ? m[0] : after.slice(0, 250)}` });
    }
    return finish('ERROR', { reason: `unexpected post-submit ${afterUrl}: ${after.slice(0, 300)}` });
  } finally {
    await context.close().catch(() => {});
  }
}

await runAdapter(main);
