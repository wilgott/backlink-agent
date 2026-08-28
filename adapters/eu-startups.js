// Adapter: EU-Startups WPBDP guest submit
// https://www.eu-startups.com/directory/?wpbdp_view=submit_listing
// Free Listing auto-selected. No account required. Country comes from product.hq.

import fs from 'node:fs';
import path from 'node:path';
import {
  readInput, initRun, record, shot, launchBrowser, finish, runAdapter,
  firstPresent, trimTo, missingField, detectCaptcha,
} from './lib/common.js';

const DEFAULT_URL = 'https://www.eu-startups.com/directory/?wpbdp_view=submit_listing';

async function dismissSilktide(page) {
  const accept = page.locator('#silktide-wrapper button:has-text("Accept all"), button:has-text("Accept all")').first();
  if (await accept.count()) {
    await accept.click({ timeout: 4000 }).catch(async () => {
      await page.evaluate(() => {
        document.getElementById('silktide-wrapper')?.remove();
        document.getElementById('silktide-backdrop')?.remove();
      });
    });
  }
  await page.evaluate(() => {
    document.getElementById('silktide-wrapper')?.remove();
    document.getElementById('silktide-backdrop')?.remove();
  });
}

async function main() {
  const { input, outputPath } = readInput();
  initRun(outputPath, input);
  const { product } = input;
  const url = (input.site && input.site.submission_url) || DEFAULT_URL;
  const missing = missingField(product, ['name', 'website', 'contact_email']);
  if (missing) return finish('BLOCKED', { reason: `missing required product field: ${missing}` });
  const shortDesc = trimTo(firstPresent(product.description_145, product.description_150, product.tagline_111), 400);
  const longDesc = trimTo(firstPresent(product.description_505, product.description_1341), 4000);
  const tags = (product.tags || []).slice(0, 4).join(', ');
  const logoPath = product.logo ? path.resolve(product.logo) : null;

  const context = await launchBrowser(input);
  const page = context.pages()[0] || (await context.newPage());
  try {
    record('goto', url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);
    await dismissSilktide(page);
    await shot(page, 'form-loaded');
    // Invisible reCAPTCHA v3/script often present. Only abort on a visible
    // challenge box (checkbox/image grid), not a hidden iframe.
    const vis = await page.evaluate(() => {
      const iframes = [...document.querySelectorAll('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare"]')];
      for (const f of iframes) {
        const r = f.getBoundingClientRect();
        if (r.width > 120 && r.height > 60 && r.bottom > 0 && r.top < innerHeight) return f.src.slice(0, 80);
      }
      return '';
    });
    record('captcha_visible_probe', vis || 'none_visible');
    if (vis && /hcaptcha|turnstile|challenges.cloudflare/i.test(vis)) {
      return finish('CAPTCHA_UNSOLVABLE', { reason: 'visible challenge iframe: ' + vis });
    }

    // Step 1: category (country) + free plan
    const country = product.hq;
    if (!country) return finish('BLOCKED', { reason: 'missing product.hq for EU-Startups country category' });
    await page.locator('select[name="listingfields[2]"]').selectOption({ label: country });
    record('category', country);
    const paid = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('input[type=radio], input[type=checkbox]')) {
        const t = ((el.closest('label,div,li') || el).innerText || '').trim();
        if (/€|\$\s*[1-9]|premium|featured|paid/i.test(t) && el.checked) {
          el.click();
          out.push(t.slice(0, 80));
        }
      }
      return out;
    });
    record('deselected_paid', paid);
    await shot(page, 'step1-category');
    const next1 = page.locator('.wpbdp-submit-listing-section-submit, button:has-text("Next"), input[value="Next"]').first();
    if (await page.getByRole('button', { name: /^next$/i }).count()) {
      await page.getByRole('button', { name: /^next$/i }).first().click({ timeout: 8000 });
    } else if (await next1.count()) {
      await next1.click({ timeout: 8000 });
    }
    await page.waitForTimeout(1500);

    await page.locator('#wpbdp-field-1').fill(product.name);
    await page.locator('#wpbdp-field-7').fill(shortDesc);
    if (longDesc) await page.locator('#wpbdp-field-3').fill(longDesc);
    await page.locator('#wpbdp-field-5').fill(product.website);
    // product.json has no city field; do not invent one.
    if (product.founded_year) await page.locator('#wpbdp-field-4').selectOption({ label: String(product.founded_year) }).catch(() => {});
    await page.locator('#wpbdp-field-8').fill(product.contact_email);
    if (tags) await page.locator('#wpbdp-field-9').fill(tags);
    await page.locator('#wpbdp-field-10').selectOption({ label: 'No funding announced yet' }).catch(async () => {
      await page.locator('#wpbdp-field-10').selectOption({ index: 1 }).catch(() => {});
    });
    const active = page.locator('#wpbdp-field-11-Active, input[name="listingfields[11]"][value="Active"]');
    if (await active.count()) await active.first().check({ force: true }).catch(() => active.first().click());
    else await page.getByText(/^Active$/).first().click().catch(() => {});
    // LinkedIn optional — leave empty when founder_linkedin is missing
    record('filled_listing', { name: product.name, email: product.contact_email });
    await shot(page, 'step2-filled');

    if (await page.getByRole('button', { name: /^next$/i }).count()) {
      await page.getByRole('button', { name: /^next$/i }).last().click({ timeout: 8000 });
      await page.waitForTimeout(1200);
    }

    if (logoPath && fs.existsSync(logoPath)) {
      const img = page.locator('#uploaded-images, input[name="images[]"]');
      if (await img.count()) {
        await img.first().setInputFiles(logoPath);
        record('uploaded_image', logoPath);
        await page.waitForTimeout(800);
      }
    }
    await shot(page, 'before-complete');

    if (input.dry_run) {
      return finish('DRY_RUN', { reason: 'dry_run: WPBDP free listing filled, stopped before Complete Listing' });
    }

    const complete = page.locator('#wpbdp-submit-listing-submit-btn, button:has-text("Complete Listing")').first();
    if (!(await complete.count())) {
      return finish('ERROR', { reason: 'Complete Listing button not found' });
    }
    await complete.click({ timeout: 8000 });
    await page.waitForTimeout(4000);
    await shot(page, 'after-submit');
    const afterUrl = page.url();
    const after = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 2500);
    record('after_submit', { afterUrl, after: after.slice(0, 700) });

    if (/thank|received|submitted|under review|listing (has been|was) (submitted|created)|pending (review|approval)/i.test(after)) {
      const links = [];
      if (!/submit_listing/i.test(afterUrl)) links.push(afterUrl);
      return finish('SUBMITTED', { confirmation_text: after.slice(0, 800), links_found: links });
    }
    if (/already (exists|listed|submitted)/i.test(after)) {
      return finish('ALREADY_SUBMITTED', { confirmation_text: after.slice(0, 500) });
    }
    if (/payment|stripe|pay now/i.test(after) && !/free listing/i.test(after)) {
      return finish('NEEDS_PAYMENT', { reason: 'payment required', requested_action: { action: 'payment', details: after.slice(0, 300) } });
    }
    return finish('ERROR', { reason: `unexpected post-submit ${afterUrl}: ${after.slice(0, 300)}` });
  } finally {
    await context.close().catch(() => {});
  }
}

await runAdapter(main);
