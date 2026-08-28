// Adapter: Tiny Startups (https://www.tinystartups.com/submit)
// Live 2026-08-27: recipe is STALE. Site is now Pay-What-You-Want.
// Flow: URL + email -> Fetch (auto account) -> name/tagline -> paid bid
// (min $39, Stripe) OR "I understand, submit for free" (badge embed required,
// queue, no backlink guarantee). Never pay. Override AI-prefilled copy.
//
// Contract: docs/ADAPTER_CONTRACT.md

import fs from 'node:fs';
import path from 'node:path';
import {
  readInput, initRun, record, shot, launchBrowser, finish, runAdapter,
  firstPresent, missingField,
} from './lib/common.js';

const DEFAULT_URL = 'https://www.tinystartups.com/submit';

async function main() {
  const { input, outputPath } = readInput();
  initRun(outputPath, input);
  const { product } = input;
  const url = (input.site && input.site.submission_url) || DEFAULT_URL;
  const missing = missingField(product, ['name', 'website', 'contact_email']);
  if (missing) return finish('BLOCKED', { reason: `missing required product field: ${missing}` });
  const tagline = firstPresent(product.tagline_50, product.tagline_39, product.tagline_111);

  const context = await launchBrowser(input);
  const page = context.pages()[0] || (await context.newPage());
  try {
    record('goto', url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);
    await shot(page, 'form-loaded');

    const siteHost = product.website.replace(/^https?:\/\//, '').replace(/\/$/, '');
    await page.getByPlaceholder(/yourstartup/i).first().fill(siteHost);
    await page.getByPlaceholder(/company.com|email/i).first().fill(product.contact_email);
    record('filled_identity', { siteHost, email: product.contact_email });
    await page.getByRole('button', { name: /^Fetch$/i }).click({ timeout: 8000 });
    await page.waitForTimeout(5000);
    await shot(page, 'after-fetch');

    const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    record('after_fetch_text', body.slice(0, 700));
    if (!/fetched/i.test(body)) {
      return finish('ERROR', { reason: `Fetch did not confirm. body=${body.slice(0, 300)}` });
    }

    const nameBox = page.getByPlaceholder(/product name/i).first();
    if (await nameBox.count()) {
      await nameBox.fill('');
      await nameBox.fill(product.name);
    }
    const tagBox = page.getByPlaceholder(/tagline/i).first();
    if (await tagBox.count() && tagline) {
      await tagBox.fill('');
      await tagBox.fill(tagline);
    }
    record('overrode_prefill', { name: product.name, tagline });

    // Never touch the paid bid / Stripe CTA. Locate the free path.
    const freeBtn = page.getByRole('button', { name: /i understand, submit for free/i }).first();
    const freeVisible = (await freeBtn.count()) > 0;
    record('free_path', { freeVisible, paidCta: /pay \$\d+/i.test(body), badge: /badge embed required/i.test(body) });
    await shot(page, 'filled');

    if (!freeVisible) {
      if (/minimum bid|stripe|pay \$/i.test(body)) {
        return finish('NEEDS_PAYMENT', {
          reason: 'Tiny Startups paid board is the default; free button not found. Minimum bid $39 via Stripe.',
          requested_action: { action: 'payment', details: body.slice(0, 400) },
        });
      }
      return finish('ERROR', { reason: 'free submit button not found after Fetch' });
    }

    if (input.dry_run) {
      return finish('DRY_RUN', { reason: 'dry_run: fetched + overrode name/tagline, stopped before free submit' });
    }

    record('submit', 'clicking I understand, submit for free');
    await freeBtn.click({ timeout: 8000 });
    // Wait out the in-button "Submitting..." state. Do NOT regex always-on
    // copy ("Join the submission queue") as success.
    for (let i = 0; i < 16; i++) {
      const t = ((await freeBtn.innerText().catch(() => '')) || '').trim();
      record('submit_btn', { i, t, url: page.url() });
      if (!/submitting/i.test(t)) break;
      await page.waitForTimeout(1500);
    }
    await page.waitForTimeout(1500);
    await shot(page, 'after-submit');
    const after = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    const afterUrl = page.url();
    record('after_submit', { afterUrl, after: after.slice(0, 800) });

    const leftSubmit = !/\/submit\/?$/i.test(new URL(afterUrl).pathname);
    const stillPayBoard = /pay \$\d+|minimum bid is \$\d+/i.test(after);
    const confirmNode = await page.getByText(/you.?re in the queue|launch (is )?queued|thanks for (your )?launch|check your email|we.?ve received your/i).count();

    const badgeSnippet = (after.match(/<a[\s\S]{0,400}tinystartups[\s\S]{0,200}<\/a>/i) || after.match(/badge embed[\s\S]{0,400}/i) || ['Badge embed required'])[0];
    if (/paste this (code|snippet)|add this badge|verify (your )?badge|badge checker/i.test(after)) {
      return finish('BLOCKED', {
        reason: 'NEEDS_BADGE: Tiny Startups free path requires a footer badge on the product site before listing. snippet=' + String(badgeSnippet).slice(0, 500),
        requested_action: { action: 'other', details: String(badgeSnippet).slice(0, 500) },
      });
    }
    if (/check(ing)? your (inbox|email)|verify your email|confirmation (link|email)/i.test(after) && !stillPayBoard) {
      return finish('NEEDS_EMAIL_VERIFICATION', {
        reason: 'Tiny Startups emailed a verification after free submit',
        email_verification: { expected_sender_pattern: 'tinystartups', expected_subject_pattern: 'verif|launch|confirm', max_wait_minutes: 30 },
      });
    }
    if (leftSubmit || confirmNode) {
      return finish('SUBMITTED', { confirmation_text: after.slice(0, 800), links_found: [afterUrl] });
    }
    if (stillPayBoard) {
      const btnNow = ((await freeBtn.innerText().catch(() => '')) || '').trim();
      return finish('ERROR', {
        reason: 'still on Tiny Startups pay/free board after free-submit click (btn=' + btnNow + '). Not a listing. Badge embed required for free path.',
      });
    }
    return finish('ERROR', { reason: 'unexpected post-submit ' + afterUrl + ': ' + after.slice(0, 350) });
  } finally {
    await context.close().catch(() => {});
  }
}

await runAdapter(main);
