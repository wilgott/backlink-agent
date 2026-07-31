// Adapter: Startup Stash (https://form.typeform.com/to/b8EyDE)
// Typeform one-question-per-screen flow.
//
// Ported from a proven pilot script that completed the full
// flow on 2026-07-29. The reliability fix is the
// [data-qa-focused="true"] focused-block driver: Typeform marks the active
// question block with that attribute, and we only ever read/act inside it.
//
// IMPORTANT: this form REJECTS consumer email domains ("we only accept
// work/business emails"). Use product.contact_email_business when available.
//
// Contract: docs/ADAPTER_CONTRACT.md
//   node adapters/startup-stash.js <input.json> <output.json>

import fs from 'node:fs';
import path from 'node:path';
import {
  readInput, initRun, record, shot, launchBrowser, finish, runAdapter,
  firstPresent, trimTo, missingField,
} from './lib/common.js';

const DEFAULT_URL = 'https://form.typeform.com/to/b8EyDE';

// --- Typeform focused-block introspection (proven pattern, do not rewrite) ---
async function activeBlock(page) {
  return await page.evaluate(() => {
    const b = document.querySelector('[data-qa-focused="true"]');
    if (!b) return null;
    const wrap = b.closest('[data-qa^="blocktype-"]') || b.parentElement;
    const type = wrap ? (wrap.getAttribute('data-qa') || '') : '';
    const inputs = Array.from(b.querySelectorAll('input,textarea')).map(i => ({
      tag: i.tagName.toLowerCase(), type: i.type, placeholder: i.placeholder, value: i.value,
    }));
    const opts = Array.from(b.querySelectorAll('li,[role="option"]')).map(o => (o.innerText || '').trim()).filter(Boolean);
    const btns = Array.from(b.querySelectorAll('button')).map(x => (x.innerText || x.getAttribute('aria-label') || '').trim()).filter(Boolean);
    const text = (b.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    const ae = document.activeElement;
    return { text, type, inputs, opts, btns, focusedTag: ae ? ae.tagName + ':' + (ae.type || '') : null };
  });
}

async function clickOption(page, want) {
  return await page.evaluate((w) => {
    const b = document.querySelector('[data-qa-focused="true"]');
    if (!b) return null;
    const els = Array.from(b.querySelectorAll('button,li,[role="option"],[role="radio"],label'));
    for (const el of els) {
      const lines = (el.innerText || '').split('\n').map(x => x.trim()).filter(Boolean);
      const last = lines[lines.length - 1] || '';
      if (last.toLowerCase() === w.toLowerCase()) { el.click(); return last; }
    }
    return null;
  }, want);
}

// Map a question text to an answer: [kind, value] where kind is
// 'short' | 'long' | 'choice' | 'file' | 'skip'. Returns null when unknown.
function makeAnswerPicker(product) {
  const founder = (product.founder_name || '').trim().split(/\s+/);
  const firstName = founder[0] || '';
  const lastName = founder.slice(1).join(' ') || founder[0] || '';
  const email = firstPresent(product.contact_email_business, product.contact_email);
  const descShort = trimTo(firstPresent(product.description_145, product.description_150, product.tagline_111), 160);
  const descLong = trimTo(firstPresent(product.description_505, product.description_145), 500);
  const logo = product.logo ? path.resolve(product.logo) : null;
  // Fallback order after the product's own categories. The pilot confirmed
  // this form has no niche-specific options; generic ones must be present.
  const categoryWants = [...(product.categories || []), 'Marketing', 'Analytics', 'Software', 'Technology']
    .filter((v, i, a) => v && a.indexOf(v) === i);

  return (q) => {
    const s = q.toLowerCase();
    if (/first name/.test(s)) return ['short', firstName];
    if (/last name/.test(s)) return ['short', lastName];
    if (/e-?mail/.test(s)) return ['short', email];
    if (/name of your product|product.{0,15}name|startup.{0,15}name/.test(s)) return ['short', product.name];
    if (/short description|up to 160/.test(s)) return ['short', descShort];
    if (/long.?description|up to 500/.test(s)) return ['long', descLong];
    if (/website|product url|url/.test(s)) return ['short', product.website];
    if (/categor/.test(s)) return ['choice', categoryWants];
    if (/logo|upload|image|file/.test(s)) {
      return logo && fs.existsSync(logo) ? ['file', logo] : ['skip', 'no logo asset available'];
    }
    if (/linkedin/.test(s)) return product.founder_linkedin ? ['short', product.founder_linkedin] : ['skip', ''];
    if (/twitter|social|x\.com/.test(s)) return ['skip', 'optional social field'];
    return null;
  };
}

async function main() {
  const { input, outputPath } = readInput();
  initRun(outputPath, input);
  const { product } = input;
  const url = (input.site && input.site.submission_url) || DEFAULT_URL;

  const missing = missingField(product, ['name', 'website', 'founder_name']);
  if (missing) return finish('BLOCKED', { reason: `missing required product field: ${missing}` });
  if (!firstPresent(product.contact_email_business, product.contact_email)) {
    return finish('BLOCKED', { reason: 'missing product.contact_email_business/contact_email' });
  }
  if (!product.contact_email_business) {
    record('warn', 'no contact_email_business; this form rejects consumer email domains — likely BLOCKED');
  }

  const pickAnswer = makeAnswerPicker(product);
  const context = await launchBrowser(input);
  const page = await context.newPage();

  try {
    record('goto', url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4500);
    await page.locator('button:has-text("Get It Started")').first().click();
    await page.waitForTimeout(2500);

    let prevText = '';
    let sameCount = 0;
    let done = false;

    for (let step = 1; step <= 30 && !done; step++) {
      const blk = await activeBlock(page);
      if (!blk) {
        // maybe thank-you screen (no focused block)
        const bodyText = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 800);
        record('no_focused_block', bodyText.slice(0, 300));
        if (/thank|submitted|received|review|touch/i.test(bodyText)) {
          await shot(page, 'confirmation');
          return finish('SUBMITTED', { confirmation_text: bodyText.slice(0, 800) });
        }
        await page.waitForTimeout(1500);
        continue;
      }

      await shot(page, `step-${String(step).padStart(2, '0')}`);
      record('block', { step, type: blk.type, q: blk.text.slice(0, 160), opts: blk.opts.map(o => o.slice(0, 40)) });

      // Hard-failure detections
      if (/only accept (work|business)|business email|work email/i.test(blk.text)) {
        return finish('BLOCKED', {
          reason: 'site rejects non-business email; set product.contact_email_business to a work-domain address',
          requested_action: { action: 'provide_business_email', details: blk.text.slice(0, 300) },
        });
      }
      if (/captcha|verify you are human/i.test(blk.text)) {
        return finish('CAPTCHA_UNSOLVABLE', { reason: `captcha in Typeform: ${blk.text.slice(0, 200)}` });
      }
      if (/payment|credit card|\$\d+/.test(blk.text) && /pay|price|cost/i.test(blk.text)) {
        return finish('NEEDS_PAYMENT', {
          reason: 'Typeform asks for payment',
          requested_action: { action: 'payment', details: blk.text.slice(0, 300) },
        });
      }

      // Stuck detection
      if (blk.text === prevText) {
        sameCount++;
        if (sameCount >= 3) {
          return finish('ERROR', { reason: `stuck on question: ${blk.text.slice(0, 200)}` });
        }
      } else { sameCount = 0; prevText = blk.text; }

      const mapped = pickAnswer(blk.text);

      // Submit screen
      if (/submit/i.test(blk.btns.join(' ')) && !blk.inputs.length) {
        if (input.dry_run) {
          await shot(page, 'dry-run-submit-screen');
          return finish('DRY_RUN', { reason: 'dry_run: reached final Submit screen, did not click' });
        }
        record('submit', 'clicking Submit');
        await page.locator('[data-qa-focused="true"] button:has-text("Submit"), button:has-text("Submit")').first().click();
        await page.waitForTimeout(4000);
        continue;
      }

      // Multiple choice (Typeform auto-advances on selection)
      if (blk.type.includes('multiple_choice') || (blk.opts.length && mapped && mapped[0] === 'choice')) {
        const wants = mapped && mapped[0] === 'choice' ? mapped[1] : ['Marketing', 'Analytics'];
        let chosen = null;
        for (const want of wants) {
          chosen = await clickOption(page, want);
          if (chosen) break;
        }
        record('choice', { wants: wants.slice(0, 5), chose: chosen });
        if (!chosen) {
          return finish('BLOCKED', { reason: `no acceptable category option (wanted: ${wants.join(', ')}); available: ${blk.opts.join(' | ').slice(0, 300)}` });
        }
        await page.waitForTimeout(2200);
        continue;
      }

      // File upload
      if (mapped && mapped[0] === 'file') {
        const fi = page.locator('[data-qa-focused="true"] input[type="file"]').first();
        if (await fi.count()) {
          await fi.setInputFiles(mapped[1]);
          record('file', { uploaded: mapped[1] });
          await page.waitForTimeout(5000);
          const ok = page.locator('[data-qa-focused="true"] button:has-text("OK")').first();
          if (await ok.count()) await ok.click().catch(() => {});
          else await page.keyboard.press('Enter');
          await page.waitForTimeout(1500);
          continue;
        }
      }

      // Text inputs
      const hasInput = blk.inputs.some(i => i.type !== 'file');
      if (hasInput) {
        const val = mapped && mapped[0] !== 'skip' ? mapped[1] : '';
        if (val) {
          await page.evaluate(() => {
            const b = document.querySelector('[data-qa-focused="true"]');
            const i = b && b.querySelector('input:not([type=file]),textarea');
            if (i) i.focus();
          });
          await page.keyboard.type(val, { delay: 8 });
          record('type', { kind: mapped[0], value: val.slice(0, 80) });
          await page.waitForTimeout(300);
        } else {
          record('skip', mapped ? mapped[1] : 'no answer mapped; advancing empty');
        }
        await page.keyboard.press('Enter');
        await page.waitForTimeout(1800);
        continue;
      }

      // Yes/No — never agree to paid promotion
      if (blk.type.includes('yes_no')) {
        const want = /advertise|paid|promot/i.test(blk.text) ? 'No' : 'Yes';
        const clicked = await clickOption(page, want);
        record('yes_no', { want, clicked });
        if (!clicked) await page.keyboard.press(want === 'No' ? 'n' : 'y');
        await page.waitForTimeout(2200);
        continue;
      }

      // Statement / interstitial block with OK button
      const okBtn = page.locator('[data-qa-focused="true"] button:has-text("OK"), [data-qa-focused="true"] button[aria-label*="OK"]').first();
      if (await okBtn.count()) { await okBtn.click(); record('ok', 'statement block'); await page.waitForTimeout(1500); continue; }

      record('fallback', 'Enter');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1500);
    }

    // Final read after the step loop
    await page.waitForTimeout(2000);
    const bodyText = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 800);
    await shot(page, 'end');
    if (/thank|submitted|received/i.test(bodyText)) {
      return finish('SUBMITTED', { confirmation_text: bodyText });
    }
    return finish('ERROR', { reason: `step loop ended without confirmation; final page: ${bodyText.slice(0, 300)}` });
  } finally {
    await context.close().catch(() => {});
  }
}

await runAdapter(main);
