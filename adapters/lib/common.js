// Shared helpers for all backlink-agent site adapters.
// Contract: docs/ADAPTER_CONTRACT.md
// Every adapter is invoked as: node adapters/<slug>.js <input.json> <output.json>

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

export const STATUSES = [
  'SUBMITTED',
  'ALREADY_SUBMITTED',
  'BLOCKED',
  'ERROR',
  'NEEDS_EMAIL_VERIFICATION',
  'NEEDS_PAYMENT',
  'NEEDS_PHONE',
  'NEEDS_OAUTH',
  'CAPTCHA_UNSOLVABLE',
  'DRY_RUN',
];

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Input / output
// ---------------------------------------------------------------------------

export function readInput() {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!inputPath || !outputPath) {
    console.error('usage: node adapters/<slug>.js <input.json> <output.json>');
    process.exit(2);
  }
  let input;
  try {
    input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (e) {
    console.error(`cannot read/parse input.json at ${inputPath}: ${e.message}`);
    process.exit(2);
  }
  input.headless = input.headless !== false; // default true
  input.dry_run = input.dry_run === true;
  input.paths = input.paths || {};
  return { input, outputPath };
}

// ---------------------------------------------------------------------------
// Run context (screenshots + transcript), initialized once per adapter run
// ---------------------------------------------------------------------------

const ctx = {
  outputPath: null,
  screenshotDir: null,
  screenshots: [],
  transcript: [],
  shotCounter: 0,
};

export function initRun(outputPath, input) {
  ctx.outputPath = outputPath;
  ctx.screenshotDir = path.resolve(input.paths.screenshot_dir || './shots');
  fs.mkdirSync(ctx.screenshotDir, { recursive: true });
  if (input.paths.user_data_dir) {
    fs.mkdirSync(path.resolve(input.paths.user_data_dir), { recursive: true });
  }
  record('run_start', { run_id: input.run_id || null, site: (input.site && input.site.name) || null, dry_run: input.dry_run });
}

export function record(step, detail) {
  ctx.transcript.push({ step, at: new Date().toISOString(), detail: detail ?? null });
}

export async function shot(page, name) {
  ctx.shotCounter += 1;
  const file = `${String(ctx.shotCounter).padStart(2, '0')}-${name}.png`;
  const full = path.join(ctx.screenshotDir, file);
  try {
    await page.screenshot({ path: full, fullPage: false });
    ctx.screenshots.push(full);
    record('screenshot', { file });
  } catch (e) {
    record('screenshot_failed', { file, error: e.message });
  }
  return full;
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

// Launches a persistent Chromium context so cookies/session survive across
// runs of the same site (paths.user_data_dir). Returns a BrowserContext;
// use `await context.newPage()`. Close with `await context.close()`.
export async function launchBrowser(input) {
  const userDataDir = path.resolve(input.paths.user_data_dir || `.profiles/${(input.site && input.site.name) || 'default'}`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: input.headless,
    viewport: { width: 1280, height: 900 },
    userAgent: DEFAULT_UA,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  return context;
}

// ---------------------------------------------------------------------------
// Finish: always writes output.json + transcript, then exits 0.
// The status field carries the outcome; a non-zero exit is reserved for
// contract violations (unreadable input), never for submission failures.
// ---------------------------------------------------------------------------

export function finish(status, fields = {}) {
  if (!STATUSES.includes(status)) {
    fields.reason = `adapter bug: invalid status ${status}` + (fields.reason ? `; ${fields.reason}` : '');
    status = 'ERROR';
  }
  const transcriptPath = ctx.screenshotDir ? path.join(ctx.screenshotDir, 'transcript.json') : null;
  if (transcriptPath) {
    record('run_end', { status, reason: fields.reason || '' });
    try {
      fs.writeFileSync(transcriptPath, JSON.stringify(ctx.transcript, null, 2));
    } catch { /* best effort */ }
  }
  const output = {
    status,
    reason: fields.reason || '',
    confirmation_text: fields.confirmation_text || null,
    submitted_at: fields.submitted_at || (status === 'SUBMITTED' ? new Date().toISOString() : null),
    email_verification: fields.email_verification || null,
    requested_action: fields.requested_action || null,
    links_found: fields.links_found || [],
    artifacts: {
      screenshots: ctx.screenshots,
      transcript: transcriptPath,
    },
  };
  try {
    fs.writeFileSync(ctx.outputPath, JSON.stringify(output, null, 2));
  } catch (e) {
    console.error(`cannot write output.json: ${e.message}`);
    process.exit(2);
  }
  console.log(`OUTCOME:${JSON.stringify({ status: output.status, reason: output.reason })}`);
  process.exit(0);
}

// Convenience wrapper: run main() and convert any uncaught throw into ERROR.
export async function runAdapter(main) {
  try {
    await main();
  } catch (e) {
    record('exception', { message: e.message, stack: (e.stack || '').split('\n').slice(0, 5) });
    finish('ERROR', { reason: e.message });
  }
}

// ---------------------------------------------------------------------------
// Form helpers (work on a Page or a Frame)
// ---------------------------------------------------------------------------

// Fill the input/textarea associated with a label (or placeholder/aria-label).
// Returns true if something was filled.
export async function fillByLabel(scope, label, value) {
  const re = label instanceof RegExp ? label : new RegExp(escapeRe(label), 'i');
  const strategies = [
    () => scope.getByLabel(re).first(),
    () => scope.getByPlaceholder(re).first(),
    () => scope.locator(`[aria-label="${typeof label === 'string' ? label : ''}"]`).first(),
  ];
  for (const make of strategies) {
    try {
      const loc = make();
      if (await loc.count()) {
        await loc.click({ timeout: 3000 }).catch(() => {});
        await loc.fill(value, { timeout: 5000 });
        return true;
      }
    } catch { /* try next strategy */ }
  }
  return false;
}

// Click a button/option whose visible text matches. Returns the matched text or null.
export async function clickByText(scope, text, { role } = {}) {
  const re = text instanceof RegExp ? text : new RegExp(`^\\s*${escapeRe(text)}\\s*$`, 'i');
  const loc = role ? scope.getByRole(role, { name: re }).first() : scope.locator(`button, [role="button"], [role="option"], li, label`).filter({ hasText: re }).first();
  try {
    if (await loc.count()) {
      const matched = (await loc.innerText().catch(() => '')) || '';
      await loc.click({ timeout: 5000 });
      return matched.trim();
    }
  } catch { /* not clickable */ }
  return null;
}

// Check a radio/checkbox whose label text matches `labelRe` within a group
// identified by input `name`. Label resolution uses the smallest container
// that wraps only that one input, so group-level question text cannot cause
// a wrong-option match. Returns the matched label text or null.
export async function checkRadioByLabelText(page, name, labelRe) {
  return await page.evaluate(({ name, reSrc }) => {
    const re = new RegExp(reSrc, 'i');
    const groupSel = `input[name="${CSS.escape(name)}"]`;
    const inputs = Array.from(document.querySelectorAll(groupSel));
    const labelOf = (inp) => {
      if (inp.id) {
        const l = document.querySelector(`label[for="${inp.id}"]`);
        if (l) return l.innerText;
      }
      const wrap = inp.closest('label');
      if (wrap && wrap.querySelectorAll('input').length === 1) return wrap.innerText;
      // classic inline pattern: <input type=radio> Option text<br>
      let t = '';
      let n = inp.nextSibling;
      while (n && !(n.nodeType === 1 && (n.tagName === 'INPUT' || n.tagName === 'BR'))) {
        t += n.nodeType === 3 ? n.textContent : (n.innerText || '');
        n = n.nextSibling;
      }
      if (t.trim()) return t;
      // walk up while the ancestor still contains only this one group input
      let text = '';
      let el = inp.parentElement;
      while (el && el.querySelectorAll(groupSel).length === 1 && (el.innerText || '').trim().length < 300) {
        text = el.innerText;
        el = el.parentElement;
      }
      return text;
    };
    for (const inp of inputs) {
      const text = (labelOf(inp) || '').replace(/\s+/g, ' ').trim();
      if (text && re.test(text)) {
        inp.click();
        return text.slice(0, 120);
      }
    }
    return null;
  }, { name, reSrc: labelRe.source });
}

// Read back the currently checked value of a radio/checkbox group (for the transcript).
export async function checkedValue(page, name) {
  return await page.evaluate((name) => {
    const c = document.querySelector(`input[name="${CSS.escape(name)}"]:checked`);
    return c ? c.value : null;
  }, name);
}

// Read the label text associated with a named input (used for math captchas).
export async function labelTextFor(page, name) {
  return await page.evaluate((name) => {
    const inp = document.querySelector(`input[name="${CSS.escape(name)}"],textarea[name="${CSS.escape(name)}"]`);
    if (!inp) return null;
    const wrap = inp.closest('label');
    if (wrap) return wrap.innerText.replace(/\s+/g, ' ').trim();
    if (inp.id) {
      const l = document.querySelector(`label[for="${inp.id}"]`);
      if (l) return l.innerText.replace(/\s+/g, ' ').trim();
    }
    // common pattern: label element as previous sibling or in parent container
    const container = inp.parentElement;
    if (container) {
      const l = container.querySelector('label');
      if (l) return l.innerText.replace(/\s+/g, ' ').trim();
      return container.innerText.replace(/\s+/g, ' ').trim().slice(0, 200);
    }
    return null;
  }, name);
}

// ---------------------------------------------------------------------------
// Captcha detection (visible challenges only — we never try to solve them)
// ---------------------------------------------------------------------------

// Returns 'recaptcha' | 'hcaptcha' | 'turnstile' | null
export async function detectCaptcha(page) {
  const checks = [
    { kind: 'recaptcha', sel: 'iframe[src*="recaptcha"], .g-recaptcha, iframe[title*="reCAPTCHA"]' },
    { kind: 'hcaptcha', sel: 'iframe[src*="hcaptcha"], .h-captcha' },
    { kind: 'turnstile', sel: 'iframe[src*="challenges.cloudflare"], .cf-turnstile' },
  ];
  for (const frame of page.frames()) {
    for (const { kind, sel } of checks) {
      try {
        if (await frame.locator(sel).first().count()) return kind;
      } catch { /* frame detached etc. */ }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

export function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Pick the first non-empty value from candidate product fields.
export function firstPresent(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

// Trim text to a hard character limit without cutting mid-word when possible.
export function trimTo(text, max) {
  const t = (text || '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.8 ? cut.slice(0, lastSpace) : cut).trim();
}

// Trim text to at most `maxWords` words.
export function trimWords(text, maxWords) {
  const words = (text || '').trim().split(/\s+/).filter(Boolean);
  return words.slice(0, maxWords).join(' ');
}

// Require product fields; returns the missing key or null.
export function missingField(product, keys) {
  for (const k of keys) {
    const v = product ? product[k] : undefined;
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length)) {
      return k;
    }
  }
  return null;
}
