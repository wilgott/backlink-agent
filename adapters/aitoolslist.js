// Adapter: aitoolslist.io (https://aitoolslist.io/submit-ai-tool/)
// Single-page Tally embed (tally.so iframe). No login, no payment.
// Proven in the pilot campaign: confirmation text "Form submitted".
//
// Field ids in the Tally iframe are UUIDs that change when the form owner
// edits the form, so all selectors key off aria-label / placeholder text
// (confirmed by live recon 2026-07-29): Your Name, Your Email, Tool Name,
// Tool's Link, Tool category, Short Description, Additional Notes.
//
// Contract: docs/ADAPTER_CONTRACT.md
//   node adapters/aitoolslist.js <input.json> <output.json>

import {
  readInput, initRun, record, shot, launchBrowser, finish, runAdapter,
  detectCaptcha, firstPresent, missingField,
} from './lib/common.js';

const DEFAULT_URL = 'https://aitoolslist.io/submit-ai-tool/';

async function fill(frame, ariaLabel, value) {
  const loc = frame.locator(`[aria-label="${ariaLabel}"]`).first();
  if (!(await loc.count())) return false;
  await loc.click({ timeout: 3000 }).catch(() => {});
  await loc.fill(value, { timeout: 5000 });
  return true;
}

async function main() {
  const { input, outputPath } = readInput();
  initRun(outputPath, input);
  const { product } = input;
  const url = (input.site && input.site.submission_url) || DEFAULT_URL;

  const missing = missingField(product, ['name', 'website', 'founder_name', 'contact_email']);
  if (missing) return finish('BLOCKED', { reason: `missing required product field: ${missing}` });
  const description = firstPresent(product.description_145, product.description_150, product.tagline_111);
  if (!description) return finish('BLOCKED', { reason: 'missing product.description_145 (or fallback) for Short Description' });
  // The category field is a free-text input and accepts generic values
  // (pilot submitted "A/B Testing, Marketing, Analytics" verbatim).
  const category = (product.categories || []).join(', ');
  const notes = (product.tags || []).length ? `Tags: ${product.tags.join(', ')}` : '';

  const context = await launchBrowser(input);
  const page = await context.newPage();

  try {
    record('goto', url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000); // Tally embed loads async
    await shot(page, 'page-loaded');

    const captcha = await detectCaptcha(page);
    if (captcha) return finish('CAPTCHA_UNSOLVABLE', { reason: `visible ${captcha} challenge on page` });

    const frame = page.frames().find(f => /tally\.so/.test(f.url()));
    if (!frame) {
      return finish('ERROR', { reason: 'Tally embed iframe (tally.so) not found on page — site markup changed?' });
    }

    const filled = {
      name: await fill(frame, 'Your Name', product.founder_name),
      email: await fill(frame, 'Your Email', product.contact_email),
      tool: await fill(frame, 'Tool Name', product.name),
      link: await fill(frame, "Tool's Link", product.website),
      category: category ? await fill(frame, 'Tool category', category) : 'skipped-empty',
      description: await fill(frame, 'Short Description', description),
      notes: notes ? await fill(frame, 'Additional Notes', notes) : 'skipped-empty',
    };
    record('filled', filled);
    const failed = Object.entries(filled).filter(([, v]) => v === false).map(([k]) => k);
    if (failed.length) {
      await shot(page, 'fill-failed');
      return finish('ERROR', { reason: `could not locate Tally fields: ${failed.join(', ')} — form structure changed?` });
    }
    await shot(page, 'filled');

    if (input.dry_run) {
      return finish('DRY_RUN', { reason: 'dry_run: Tally form filled, stopped before Submit' });
    }

    record('submit', 'clicking Submit');
    await frame.locator('button:has-text("Submit")').first().click();
    await page.waitForTimeout(5000);
    await shot(page, 'after-submit');

    const frameText = (await frame.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 1500);
    const pageText = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 1500);
    const combined = `${frameText} ${pageText}`;
    record('after_submit_text', combined.slice(0, 500));

    if (/thank|form submitted|submission (received|successful)|received your/i.test(combined)) {
      return finish('SUBMITTED', { confirmation_text: frameText || pageText });
    }
    if (/already (been )?submitted|duplicate/i.test(combined)) {
      return finish('ALREADY_SUBMITTED', { confirmation_text: combined.slice(0, 500) });
    }
    const validation = combined.match(/(this field is required|invalid (email|url|link)|please (fill|enter|check))[^.!?]{0,120}/i);
    if (validation) {
      return finish('ERROR', { reason: `Tally validation failed: ${validation[0]}` });
    }
    return finish('ERROR', { reason: `unexpected post-submit state: ${combined.slice(0, 300)}` });
  } finally {
    await context.close().catch(() => {});
  }
}

await runAdapter(main);
