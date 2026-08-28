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

    // Cookie consent overlay (silktide) intercepts pointer events. Dismiss
    // or strip it on load AND again immediately before the submit click —
    // the banner can reappear after fill.
    async function dismissSilktide() {
      const accept = page.locator('#silktide-wrapper button:has-text("Accept all"), button:has-text("Accept all")').first();
      if (await accept.count()) {
        await accept.click({ timeout: 5000 }).catch(async () => {
          await page.evaluate(() => {
            document.getElementById('silktide-wrapper')?.remove();
            document.getElementById('silktide-backdrop')?.remove();
          });
        });
      }
      await page.evaluate(() => {
        document.getElementById('silktide-wrapper')?.remove();
        document.getElementById('silktide-backdrop')?.remove();
        document.querySelectorAll('[id*="silktide"], .silktide-backdrop').forEach((el) => el.remove());
      });
      await page.locator('#silktide-backdrop, #silktide-wrapper').waitFor({ state: 'detached', timeout: 3000 }).catch(() => {});
    }
    await dismissSilktide();

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
    // Click ONLY the form's input[name="formSubmit"]. The header CTA
    // "Submit Startup +" is a <button> that navigates to /submit/ and wipes
    // the filled form (false SUBMITTED on the previous live run).
    await dismissSilktide();
    const submitBtn = page.locator('input[name="formSubmit"]');
    if (!(await submitBtn.count())) {
      return finish('ERROR', { reason: 'input[name="formSubmit"] not found — cannot submit without hitting the header CTA' });
    }
    record('submit', 'clicking input[name=formSubmit] only');
    const urlBefore = page.url();
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null),
      submitBtn.first().click({ timeout: 8000, force: true }),
    ]);
    // Cloudflare often serves a "Please wait while your request is being
    // verified..." / "One moment, please..." interstitial on the POST.
    // That is a JS challenge, not a visual captcha — wait it out.
    async function onCfInterstitial() {
      const title = (await page.title().catch(() => '')).toLowerCase();
      const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 400).toLowerCase();
      return /one moment|please wait while your request is being verified|checking your browser|just a moment/i.test(title + ' ' + body);
    }
    for (let i = 0; i < 18; i++) {
      if (!(await onCfInterstitial())) break;
      record('cf_wait', { i, title: await page.title().catch(() => ''), url: page.url() });
      if (i === 0) await shot(page, 'cf-interstitial');
      await page.waitForTimeout(2500);
    }
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1500);
    await shot(page, 'after-submit');
    if (await onCfInterstitial()) {
      return finish('ERROR', {
        reason: `Cloudflare verification interstitial did not clear after waiting (~45s). url=${page.url()} title=${await page.title().catch(() => '')}`,
      });
    }

    const urlAfter = page.url();
    const leftSubmit = !/\/submit\/?(\?|$)/i.test(new URL(urlAfter).pathname);
    record('after_submit_url', { urlBefore, urlAfter, leftSubmit });

    const bodyText = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 3000);
    record('after_submit_text', bodyText.slice(0, 600));

    if (/already (been )?submitted/i.test(bodyText)) {
      return finish('ALREADY_SUBMITTED', { confirmation_text: bodyText.slice(0, 500), links_found: [urlAfter] });
    }

    // Validation failure: still on the form with an error message
    const stillOnForm = (await page.locator('input[name="startupname"]').count()) > 0;
    const errorMatch = bodyText.match(/(error|invalid|incorrect|wrong|please (fill|enter|correct)|required)[^.!?]{0,160}/i);
    if (stillOnForm && errorMatch) {
      return finish('ERROR', { reason: `form validation failed: ${errorMatch[0]}` });
    }
    // stillOnForm with NO error is the previous false-positive path (header
    // CTA or cookie overlay ate the click). Never call that SUBMITTED.
    if (stillOnForm && !leftSubmit) {
      return finish('ERROR', {
        reason: `still on /submit/ with startupname field present after clicking formSubmit (url=${urlAfter}). Form was not posted.`,
      });
    }

    // The site offers a paid "within 1-business day" upgrade AFTER the free
    // submission. Never pay: only report NEEDS_PAYMENT if payment is required
    // to complete the submission itself.
    const paymentRequired = /(card number|payment required|pay now to (submit|complete))/i.test(bodyText);
    if (paymentRequired && !leftSubmit) {
      return finish('NEEDS_PAYMENT', {
        reason: 'site requires payment to complete submission',
        requested_action: { action: 'payment', details: bodyText.slice(0, 300) },
      });
    }

    // Success = we left /submit/ OR a dedicated confirmation node is present.
    // Do NOT regex the landing-page marketing copy (it always contains
    // "review" / "publish" / "submitted").
    const confirmNode = page.locator(
      '.success, .thank-you, .confirmation, [class*="success"], [class*="thank"], [role="status"], h1, h2',
    ).filter({ hasText: /thank you|submission received|successfully submitted|we.?ve received|your startup (is|has been)/i });
    const hasConfirmNode = (await confirmNode.count()) > 0;
    record('confirm_check', { leftSubmit, hasConfirmNode, stillOnForm });
    if (leftSubmit || hasConfirmNode) {
      const snippet = hasConfirmNode
        ? (await confirmNode.first().innerText().catch(() => bodyText)).slice(0, 800)
        : bodyText.slice(0, 800);
      return finish('SUBMITTED', { confirmation_text: snippet, links_found: [urlAfter] });
    }

    return finish('ERROR', { reason: `unexpected post-submit page (still on form=${stillOnForm} url=${urlAfter}): ${bodyText.slice(0, 300)}` });
  } finally {
    await context.close().catch(() => {});
  }
}

await runAdapter(main);
