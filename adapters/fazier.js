// Adapter: Fazier (https://fazier.com/submit)
// Own email/password auth. LOGIN with stored creds (account.json in the
// persistent profile) or reuse the session. Never Join / never create a new
// account. Never pay Lite/Premium. Never OAuth. Never solve captchas.
// Free Basic requires a reciprocal backlink/badge on homepage or footer.
// If that still gates listing -> BLOCKED NEEDS_BADGE with exact snippet.
//
// Contract: docs/ADAPTER_CONTRACT.md

import fs from 'node:fs';
import path from 'node:path';
import {
  readInput, initRun, record, shot, launchBrowser, finish, runAdapter,
  firstPresent, missingField, fillByLabel, detectCaptcha,
} from './lib/common.js';

const LOGIN_URL = 'https://fazier.com/login';
const SUBMIT_URL = 'https://fazier.com/submit';
const BADGE_SNIPPET_DEFAULT = 'A backlink to our site is required (on your homepage or footer)';

function loadStoredCreds(dir) {
  const f = path.join(dir, 'account.json');
  if (!fs.existsSync(f)) return null;
  try {
    const creds = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (creds && creds.email && creds.password) return creds;
  } catch { /* missing / corrupt */ }
  return null;
}

function extractBadgeSnippet(text) {
  const t = String(text || '');
  const preferred = [
    'A backlink to our site is required (on your homepage or footer)',
    'Add the Fazier badge to your site to complete your free launch.',
    'A Fazier badge is visible on your website (see example).',
    'Free with embed badge',
    'Step 3: Embed Fazier Badge',
  ];
  const found = preferred.filter((s) => t.toLowerCase().includes(s.toLowerCase()));
  if (found.length) return found.join(' | ').slice(0, 500);
  const patterns = [
    /<a[\s\S]{0,200}fazier[\s\S]{0,200}<\/a>/i,
    /add the fazier badge[\s\S]{0,80}/i,
  ];
  for (const p of patterns) {
    const m = t.match(p);
    if (m) return m[0].replace(/\s+/g, ' ').trim().slice(0, 500);
  }
  return null;
}

async function bodyText(page) {
  return (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
}

async function stopIfCaptcha(page, where) {
  const kind = await detectCaptcha(page);
  if (!kind) return;
  await shot(page, 'captcha');
  return finish('CAPTCHA_UNSOLVABLE', {
    reason: `Fazier ${where} blocked by ${kind}; did not solve. url=${page.url()}`,
  });
}

async function looksLoggedIn(page) {
  const url = page.url();
  const body = await bodyText(page);
  if (/\/login|\/signup/i.test(url)) return false;
  if (await page.getByRole('button', { name: /continue with email/i }).count()) return false;
  if (await page.getByRole('button', { name: /^join$/i }).count()) return false;
  if (/welcome to fazier|login to fazier|create your account|check your inbox/i.test(body)) return false;
  if (await page.getByRole('button', { name: /log out|sign out|logout/i }).count()) return true;
  if (await page.getByRole('link', { name: /log out|sign out|logout/i }).count()) return true;
  if (await page.getByText(/log out|sign out/i).count()) return true;
  // Header "Log in" / "Sign up" still present => not authenticated
  const loginCta = page.getByRole('link', { name: /^(log in|sign in|sign up)$/i });
  if (await loginCta.count()) return false;
  return false;
}

async function ensureLoggedIn(page, creds) {
  record('goto', LOGIN_URL);
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2000);
  await shot(page, 'login-loaded');
  await stopIfCaptcha(page, 'login');

  // Session reuse: /login often redirects away when already authenticated.
  if (await looksLoggedIn(page) || (!/\/login|\/signup/i.test(page.url()) && !(await page.getByRole('button', { name: /continue with email/i }).count()))) {
    const maybeIn = !/\/login|\/signup/i.test(page.url()) && !(await page.getByRole('button', { name: /continue with email/i }).count());
    if (maybeIn) {
      record('session', { reused: true, url: page.url() });
      await shot(page, 'session-reused');
      return true;
    }
  }

  const emailBtn = page.getByRole('button', { name: /continue with email/i }).first();
  if (await emailBtn.count()) {
    await emailBtn.click({ timeout: 5000 });
    await page.waitForTimeout(1500);
  } else {
    // Maybe already on the email form, or a "Log in" link on signup.
    const logInLink = page.getByRole('link', { name: /^log in$/i }).first();
    if (await logInLink.count()) {
      await logInLink.click({ timeout: 5000 });
      await page.waitForTimeout(1500);
      const emailBtn2 = page.getByRole('button', { name: /continue with email/i }).first();
      if (await emailBtn2.count()) {
        await emailBtn2.click({ timeout: 5000 });
        await page.waitForTimeout(1500);
      }
    }
  }
  await shot(page, 'login-email-form');
  await stopIfCaptcha(page, 'login email form');

  // Refuse the signup Join path.
  const joinBtn = page.getByRole('button', { name: /^join$/i }).first();
  const loginBtnPreview = page.getByRole('button', { name: /^(log in|sign in|login)$/i }).first();
  if (await joinBtn.count() && !(await loginBtnPreview.count())) {
    // Landed on Create-account. Go to /login explicitly.
    record('wrong_path', 'signup Join visible; navigating to /login');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1500);
    const emailBtn3 = page.getByRole('button', { name: /continue with email/i }).first();
    if (await emailBtn3.count()) {
      await emailBtn3.click({ timeout: 5000 });
      await page.waitForTimeout(1500);
    }
    await shot(page, 'login-email-form-retry');
  }

  const emailInp = page.locator('input[type="email"]').first();
  if (!(await emailInp.count())) {
    const body = await bodyText(page);
    if (/continue with google/i.test(body) && !(await emailInp.count())) {
      return finish('NEEDS_OAUTH', {
        reason: 'Fazier login is OAuth-only in this view (email form not shown)',
        requested_action: { action: 'oauth_login', details: 'Google OAuth required; refused' },
      });
    }
    return finish('ERROR', { reason: `email field not found on Fazier login. url=${page.url()} body=${body.slice(0, 280)}` });
  }
  await emailInp.fill(creds.email);

  let passInp = page.locator('input[type="password"]').first();
  if (!(await passInp.count())) {
    const cont = page.getByRole('button', { name: /continue|next|log in|sign in/i }).first();
    if (await cont.count()) {
      await cont.click({ timeout: 5000 });
      await page.waitForTimeout(1500);
    }
    passInp = page.locator('input[type="password"]').first();
  }
  if (!(await passInp.count())) {
    return finish('ERROR', { reason: `password field not found on Fazier login. url=${page.url()}` });
  }
  await passInp.fill(creds.password);
  await shot(page, 'login-filled');

  // Never click Join.
  if (await page.getByRole('button', { name: /^join$/i }).count()
      && !(await page.getByRole('button', { name: /^(log in|sign in|login)$/i }).count())) {
    return finish('ERROR', { reason: 'landed on signup Join form; refusing to create a new Fazier account' });
  }

  const loginBtn = page.getByRole('button', { name: /^(log in|sign in|login|continue)$/i }).first();
  if (!(await loginBtn.count())) {
    return finish('ERROR', { reason: `no Log in button on Fazier login form. url=${page.url()}` });
  }
  await loginBtn.click({ timeout: 8000 });
  await page.waitForTimeout(4000);
  await shot(page, 'after-login');
  record('after_login', { url: page.url() });
  await stopIfCaptcha(page, 'after login');

  const after = await bodyText(page);
  record('after_login_text', after.slice(0, 600));
  if (/invalid|incorrect (email|password)|wrong password|couldn't find|does not exist|no account/i.test(after)) {
    return finish('ERROR', { reason: `Fazier login rejected stored creds. url=${page.url()} body=${after.slice(0, 280)}` });
  }
  if (/verify your email|check your (inbox|email)|confirmation (link|email)|we sent|finish setting up your account/i.test(after)) {
    return finish('NEEDS_EMAIL_VERIFICATION', {
      reason: `Fazier still wants email verification after login. url=${page.url()}`,
      email_verification: { expected_sender_pattern: 'fazier', expected_subject_pattern: 'verif|confirm|fazier', max_wait_minutes: 30 },
    });
  }
  if (/\/login/i.test(page.url()) && /continue with email|login to fazier/i.test(after)) {
    return finish('ERROR', { reason: `Fazier login did not leave /login. url=${page.url()} body=${after.slice(0, 280)}` });
  }
  record('login', { ok: true, url: page.url() });
  return true;
}

async function clickFreeSubmit(page) {
  const paid = page.getByRole('link', { name: /buy now|get premium|get super/i });
  record('paid_ctas_visible', { count: await paid.count() });

  const card = page.locator('div,section,article,li').filter({ hasText: /backlink to our site is required/i }).first();
  if (await card.count()) {
    const btn = card.locator('a,button,[role="button"]').filter({ hasText: /^submit$/i }).first();
    if (await btn.count()) {
      await btn.click({ timeout: 5000 });
      return 'card-submit';
    }
  }
  const byRole = page.getByRole('link', { name: /^submit$/i }).first();
  if (await byRole.count()) {
    await byRole.click({ timeout: 5000 });
    return 'link-submit';
  }
  const byBtn = page.getByRole('button', { name: /^submit$/i }).first();
  if (await byBtn.count()) {
    await byBtn.click({ timeout: 5000 });
    return 'button-submit';
  }
  const embed = page.getByRole('link', { name: /free with embed badge/i }).first();
  if (await embed.count()) {
    await embed.click({ timeout: 5000 });
    return 'embed-badge-link';
  }
  return null;
}

async function fillVisibleProductFields(page, product) {
  const tagline = firstPresent(product.tagline_39, product.tagline_50, product.tagline_111);
  const desc = firstPresent(product.description_505, product.description_150, product.description_145);
  const filled = [];
  const pairs = [
    [/product name|^name$/i, product.name],
    [/tagline|headline|short description/i, tagline],
    [/website|product url|launch url|^url$/i, product.website],
    [/description|about your product|long description/i, desc],
    [/github/i, product.founder_github || ''],
  ];
  for (const [re, val] of pairs) {
    if (!val) continue;
    try {
      if (await fillByLabel(page, re, val)) filled.push(String(re));
    } catch { /* field not on this step */ }
  }
  const urlInp = page.locator('input[type="url"]').first();
  if (await urlInp.count()) {
    const cur = await urlInp.inputValue().catch(() => '');
    if (!cur) {
      await urlInp.fill(product.website);
      filled.push('input[type=url]');
    }
  }
  if (product.logo) {
    const file = page.locator('input[type="file"]').first();
    const logoPath = path.resolve(product.logo);
    if (await file.count() && fs.existsSync(logoPath)) {
      await file.setInputFiles(logoPath).catch(() => {});
      filled.push('logo');
    }
  }
  record('filled_fields', filled);
  return filled;
}

function isBadgeGated(text) {
  const t = String(text || '');
  if (/backlink to our site is required/i.test(t)) return true;
  if (/free with embed badge/i.test(t)) return true;
  if (/(badge|backlink).{0,80}(required|verify|verification)/i.test(t) && /(homepage|footer|embed)/i.test(t)) return true;
  if (/add (the |our )?(badge|backlink)/i.test(t) && /(homepage|footer|your (web)?site)/i.test(t)) return true;
  if (/we (couldn'?t|cannot|can't) (find|verify|detect).{0,60}(badge|backlink|fazier)/i.test(t)) return true;
  return false;
}

function finishNeedsBadge(page, text, extra) {
  const snip = extractBadgeSnippet(text) || BADGE_SNIPPET_DEFAULT;
  return finish('BLOCKED', {
    reason: `NEEDS_BADGE: Fazier Basic free listing requires a reciprocal backlink/badge on homepage or footer before listing. snippet=${snip}`,
    requested_action: { action: 'other', details: snip },
    confirmation_text: String(text || '').slice(0, 800),
    links_found: extra && extra.links ? extra.links : [],
  });
}

async function main() {
  const { input, outputPath } = readInput();
  initRun(outputPath, input);
  const { product } = input;
  const missing = missingField(product, ['name', 'website']);
  if (missing) return finish('BLOCKED', { reason: `missing required product field: ${missing}` });

  const userDataDir = path.resolve(input.paths.user_data_dir || './state/profiles/fazier');
  const creds = loadStoredCreds(userDataDir);
  if (!creds) {
    return finish('ERROR', { reason: 'no stored Fazier account.json; refusing to create a new account' });
  }
  record('account', { email: creds.email });

  const context = await launchBrowser(input);
  const page = context.pages()[0] || (await context.newPage());
  try {
    await ensureLoggedIn(page, creds);

    record('goto', SUBMIT_URL);
    await page.goto(SUBMIT_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);
    await shot(page, 'submit-page');
    await stopIfCaptcha(page, 'submit');

    let sub = await bodyText(page);
    record('submit_page', { url: page.url(), text: sub.slice(0, 700) });

    // If submit bounced us back to login, try login once more then return.
    if (/\/login|\/signup/i.test(page.url()) || /continue with email/i.test(sub.slice(0, 400))) {
      record('submit_requires_auth', page.url());
      await ensureLoggedIn(page, creds);
      await page.goto(SUBMIT_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2500);
      await shot(page, 'submit-page-after-relogin');
      sub = await bodyText(page);
      record('submit_page_2', { url: page.url(), text: sub.slice(0, 700) });
    }

    const pricingBadge = extractBadgeSnippet(sub);
    record('pricing_badge_copy', pricingBadge);

    // Never click paid CTAs. Click only Basic/Free Submit.
    const clicked = await clickFreeSubmit(page);
    record('free_click', { clicked, url: page.url() });
    await page.waitForTimeout(3000);
    await shot(page, 'after-free-click');
    await stopIfCaptcha(page, 'after free submit click');

    let after = await bodyText(page);
    record('after_free_click', { url: page.url(), text: after.slice(0, 700) });

    if (/stripe|checkout|payment|card number/i.test(page.url() + ' ' + after.slice(0, 250))) {
      return finish('NEEDS_PAYMENT', {
        reason: `Fazier navigated toward payment after free click; did not pay. url=${page.url()}`,
        requested_action: { action: 'payment', details: after.slice(0, 400) },
      });
    }

    // Walk a short product-form wizard if one appeared.
    for (let step = 0; step < 6; step++) {
      after = await bodyText(page);
      if (isBadgeGated(after) && !(await page.locator('input[type="text"], input[type="url"], textarea').count())) {
        await shot(page, 'badge-gate');
        return finishNeedsBadge(page, after);
      }
      // Verify-backlink wall (no product fields, just badge instructions / HTML snippet)
      const hasEmbed = /<a |iframe|img /i.test(after) && /fazier/i.test(after);
      if (hasEmbed && /homepage|footer|embed|paste/i.test(after) && !(await page.locator('input[type="text"], textarea').count())) {
        await shot(page, 'badge-embed');
        return finishNeedsBadge(page, after);
      }

      const filled = await fillVisibleProductFields(page, product);
      // Pick a matching category/topic if chips/buttons are present.
      for (const cat of (product.categories || []).concat(product.tags || [])) {
        const chip = page.getByRole('button', { name: new RegExp(`^${cat}$`, 'i') }).first();
        if (await chip.count()) {
          await chip.click({ timeout: 2000 }).catch(() => {});
          record('clicked_topic', cat);
          break;
        }
      }
      await shot(page, `form-step-${step}`);

      const next = page.getByRole('button', { name: /^(next|continue|save and continue)$/i }).first();
      const finalFree = page.getByRole('button', { name: /submit( for free)?$|launch for free|publish for free/i }).first();
      const verify = page.getByRole('button', { name: /verify (badge|backlink)|check (badge|backlink)/i }).first();

      if (await verify.count()) {
        await verify.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(3000);
        await shot(page, 'after-verify-badge');
        const vtxt = await bodyText(page);
        record('after_verify', { url: page.url(), text: vtxt.slice(0, 500) });
        if (isBadgeGated(vtxt) || /not found|missing|couldn'?t|failed|add .{0,20}badge/i.test(vtxt)) {
          return finishNeedsBadge(page, vtxt);
        }
      }

      if (await finalFree.count()) {
        if (input.dry_run) {
          return finish('DRY_RUN', { reason: `dry_run: free submit form ready, stopped before final click. url=${page.url()}` });
        }
        await finalFree.click({ timeout: 8000 });
        await page.waitForTimeout(4000);
        await shot(page, 'after-final-submit');
        const done = await bodyText(page);
        record('after_final', { url: page.url(), text: done.slice(0, 700) });
        if (isBadgeGated(done) || /add .{0,20}(badge|backlink)|verify.{0,20}(badge|backlink)/i.test(done)) {
          return finishNeedsBadge(page, done);
        }
        if (/already (listed|submitted|launched)|duplicate/i.test(done)) {
          return finish('ALREADY_SUBMITTED', { reason: `Fazier reports already listed. url=${page.url()}`, confirmation_text: done.slice(0, 800) });
        }
        if (/thank you|submitted|under review|we.?ll review|listed within|received your/i.test(done)) {
          const links = [];
          const hrefs = await page.locator('a[href*="fazier.com"]').evaluateAll((as) => as.map((a) => a.href)).catch(() => []);
          for (const h of hrefs) {
            if (/\/launches?\/|\/products?\//i.test(h) && !/submit|login|signup/i.test(h)) links.push(h);
          }
          return finish('SUBMITTED', {
            confirmation_text: done.slice(0, 800),
            submitted_at: new Date().toISOString(),
            links_found: links,
          });
        }
        return finish('ERROR', { reason: `clicked free submit but no confirmation. url=${page.url()} body=${done.slice(0, 280)}` });
      }

      if (await next.count() && filled.length) {
        await next.click({ timeout: 5000 });
        await page.waitForTimeout(2000);
        continue;
      }
      break;
    }

    after = await bodyText(page);
    // Pricing page still showing the Basic backlink requirement after the click
    // (or a dedicated badge-verify screen) — this is the known free-tier gate.
    if (isBadgeGated(after) || pricingBadge) {
      await shot(page, 'still-gated');
      return finishNeedsBadge(page, after || sub);
    }

    if (input.dry_run) {
      return finish('DRY_RUN', { reason: `dry_run: reached submit after login. url=${page.url()}` });
    }
    return finish('ERROR', {
      reason: `logged in but could not complete free submit. url=${page.url()} body=${after.slice(0, 280)}`,
    });
  } finally {
    await context.close().catch(() => {});
  }
}

await runAdapter(main);
