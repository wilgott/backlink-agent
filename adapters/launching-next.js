// Adapter: Launching Next (https://www.launchingnext.com/submit/)
// Pure public HTML form, no login, math captcha, free tier.
// Proven in the pilot campaign: free submission succeeds;
// publication is the confirmation (no ack email).
//
// Contract: docs/ADAPTER_CONTRACT.md
//   node adapters/launching-next.js <input.json> <output.json>

import {
  readInput, initRun, record, shot, launchBrowser, finish, runAdapter,
  checkRadioByLabelText, checkedValue, labelTextFor, detectCaptcha,
  firstPresent, trimTo, trimWords, missingField,
} from './lib/common.js';

const DEFAULT_URL = 'https://www.launchingnext.com/submit/';

async function main() {
  const { input, outputPath } = readInput();
  initRun(outputPath, input);
  const { product } = input;
  const url = (input.site && input.site.submission_url) || DEFAULT_URL;

  const missing = missingField(product, ['name', 'website', 'founder_name', 'contact_email']);
  if (missing) return finish('BLOCKED', { reason: `missing required product field: ${missing}` });

  const headline = trimWords(firstPresent(product.tagline_66, product.tagline_50, product.tagline_39), 8);
  const fullDescription = trimTo(firstPresent(product.description_2192, product.description_1341, product.description_505, product.description_145), 2500);
  const tags = (product.tags || []).slice(0, 10).join(', ');
  if (!headline) return finish('BLOCKED', { reason: 'missing product.tagline_66 (or any tagline) for headline' });
  if (!fullDescription) return finish('BLOCKED', { reason: 'missing product.description_* for full description' });
  if ((product.tags || []).length < 5) record('warn', 'fewer than 5 tags available; form asks for 5-10');

  const context = await launchBrowser(input);
  const page = await context.newPage();
  try {
    record('goto', url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);
    await shot(page, 'form-loaded');

    const captcha = await detectCaptcha(page);
    if (captcha) return finish('CAPTCHA_UNSOLVABLE', { reason: `visible ${captcha} challenge on form` });

    // Cookie consent overlay (silktide) intercepts pointer events — dismiss
    // it, or remove the overlay outright if the button is unreachable.
    const accept = page.locator('#silktide-wrapper button:has-text("Accept all"), button:has-text("Accept all")').first();
    if (await accept.count()) {
      await accept.click({ timeout: 5000 }).catch(async () => {
        await page.evaluate(() => document.getElementById('silktide-wrapper')?.remove());
      });
    }
    await page.locator('#silktide-backdrop').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});

    // --- Fill the form (field names confirmed by live recon 2026-07-29) ---
    await page.locator('input[name="startupname"]').fill(product.name);
    await page.locator('input[name="startupurl"]').fill(product.website);
    await page.locator('input[name="description"]').fill(headline);
    await page.locator('textarea[name="fulldescription"]').fill(fullDescription);
    if (tags) await page.locator('textarea[name="tags"]').fill(tags);
    record('filled', { name: product.name, headline, description_chars: fullDescription.length, tags });

    // Funding: "A bootstrapped startup" (radio group name=funding)
    const funding = await checkRadioByLabelText(page, 'funding', /bootstrapped/i);
    record('radio', { group: 'funding', chose: funding, checked: await checkedValue(page, 'funding') });
    if (!funding) record('warn', 'could not match funding radio "bootstrapped" — leaving default');

    // Marketing budget: "$0" (must not match "$1,000" etc.)
    const budget = await checkRadioByLabelText(page, 'marketing_budget', /\$0(?![\d,])/);
    record('radio', { group: 'marketing_budget', chose: budget, checked: await checkedValue(page, 'marketing_budget') });
    if (!budget) record('warn', 'could not match marketing_budget radio "$0" — leaving default');

    // Contact
    await page.locator('input[name="user"]').fill(product.founder_name);
    await page.locator('input[name="email"]').fill(product.contact_email);

    // Newsletter opt-in: leave unchecked — it is PRE-CHECKED by default and
    // we must not subscribe the contact address. JS toggle avoids overlay
    // pointer-interception issues.
    await page.evaluate(() => {
      const cb = document.querySelector('input[name="newsletter_optin"]');
      if (cb && cb.checked) {
        cb.checked = false;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    // Math captcha: label like "Quick Check: What is 2+3?"
    const mathLabel = (await labelTextFor(page, 'math')) || '';
    record('math_question', mathLabel);
    const m = mathLabel.match(/(-?\d+)\s*([+\-x×*])\s*(-?\d+)/i);
    if (!m) return finish('ERROR', { reason: `could not parse math captcha question: "${mathLabel}"` });
    const a = parseInt(m[1], 10);
    const b = parseInt(m[3], 10);
    const op = m[2];
    const answer = op === '+' ? a + b : op === '-' ? a - b : a * b;
    await page.locator('input[name="math"]').fill(String(answer));
    record('math_answer', { question: m[0], answer });
    await shot(page, 'filled');

    if (input.dry_run) {
      return finish('DRY_RUN', { reason: 'dry_run: form filled, stopped before final submit' });
    }

    // --- Submit ---
    record('submit', 'clicking Submit Startup');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null),
      page.locator('input[name="formSubmit"], button:has-text("Submit Startup")').first().click(),
    ]);
    await page.waitForTimeout(3000);
    await shot(page, 'after-submit');

    const bodyText = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 3000);
    record('after_submit_text', bodyText.slice(0, 600));

    if (/already (been )?submitted/i.test(bodyText)) {
      return finish('ALREADY_SUBMITTED', { confirmation_text: bodyText.slice(0, 500) });
    }

    // Validation failure: still on the form with an error message
    const stillOnForm = await page.locator('input[name="startupname"]').count();
    const errorMatch = bodyText.match(/(error|invalid|incorrect|wrong|please (fill|enter|correct)|required)[^.!?]{0,160}/i);
    if (stillOnForm && errorMatch) {
      return finish('ERROR', { reason: `form validation failed: ${errorMatch[0]}` });
    }

    // The site offers a paid "within 1-business day" upgrade AFTER the free
    // submission. Never pay: only report NEEDS_PAYMENT if payment is required
    // to complete the submission itself.
    const paymentRequired = /(card number|payment required|pay now to (submit|complete))/i.test(bodyText)
      && !/thank|received|review|submitted/i.test(bodyText);
    if (paymentRequired) {
      return finish('NEEDS_PAYMENT', {
        reason: 'site requires payment to complete submission',
        requested_action: { action: 'payment', details: bodyText.slice(0, 300) },
      });
    }

    if (/thank|received|review|submitted|publish/i.test(bodyText)) {
      return finish('SUBMITTED', { confirmation_text: bodyText.slice(0, 800) });
    }

    return finish('ERROR', { reason: `unexpected post-submit page: ${bodyText.slice(0, 300)}` });
  } finally {
    await context.close().catch(() => {});
  }
}

await runAdapter(main);
