# Field patterns: what real directories do and how to handle it

Hard-won lessons from a live backlink campaign (klinky.io, July 2026). Each
pattern lists the symptom, how to detect it, the solution that worked, and
the sites it was confirmed on. Check here **before** writing a new adapter or
debugging a stuck submission — the surprise was probably already solved.

Related: [ADAPTER_CONTRACT.md](ADAPTER_CONTRACT.md) (mechanics),
[AGENTS.md](AGENTS.md) (operating rules).

## 1. Supabase-auth sites with OAuth-only UI: sign up via the GoTrue API anyway

**Symptom.** The login page only shows Google/X OAuth buttons. No
email/password form anywhere in the UI.

**Detection.** Page source or network calls reference `*.supabase.co` or
`supabase` JS client; the JS bundle contains a public anon key
(`eyJ...` JWT) and a project URL.

**Solution.** Supabase's GoTrue API accepts email/password signup regardless
of what the UI exposes:

```js
// anon key + project ref come from the site's own JS bundle (public by design)
const res = await fetch(`${supabaseUrl}/auth/v1/signup`, {
  method: 'POST',
  headers: { apikey: anonKey, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
const session = await res.json(); // { access_token, refresh_token, ... }
// inject into the browser profile's localStorage:
await page.evaluate(([key, val]) => localStorage.setItem(key, val),
  [`sb-${projectRef}-auth-token`, JSON.stringify(session)]);
```

Reload and the UI is logged in. The localStorage key format is
`sb-{project-ref}-auth-token`.

**Confirmed on:** Microlaunch (full submission completed this way).

## 2. NextAuth sites: credentials login is an API, not a form

**Symptom.** Login UI is awkward, OAuth-heavy, or the registration page is
hidden, but the app runs NextAuth (`/api/auth/*` endpoints respond).

**Detection.** `GET /api/auth/csrf` returns JSON with a `csrfToken`.

**Solution.** Drive the credentials provider directly with the browser's own
request context (cookies land in the profile automatically):

```js
const csrfRes = await page.request.get(`${base}/api/auth/csrf`);
const { csrfToken } = await csrfRes.json();
await page.request.post(`${base}/api/auth/callback/credentials`, {
  form: { csrfToken, email, password, json: 'true' },
});
const session = await page.request.get(`${base}/api/auth/session`); // verify
```

Two bonuses worth probing before giving up on account creation:
`/api/auth/register` often exists even when the UI hides it, and
magic-link verify endpoints exist but are **single-use** — opening one twice
invalidates it.

**Confirmed on:** Tiny Startups.

## 3. better-auth sites: probe signup; let Turnstile solve itself

**Symptom.** Email/password signup looks available but fails; a Cloudflare
Turnstile widget sits on the form.

**Detection.** `POST /api/auth/sign-up/email` returns
`EMAIL_AND_PASSWORD_SIGN_UP_IS_NOT_ENABLED` (better-auth error code). The
whole OpenHunts network (OpenHunts, ToolFio, Twelve Tools, Open Launch,
Fazier) runs better-auth with email signup disabled server-side — only
Google/GitHub OAuth works, and magic-link/OTP endpoints 404. Adapter answer:
`NEEDS_OAUTH`, never a workaround.

**Solution (Turnstile).** Do nothing. Turnstile auto-solves in a normal
Chromium profile in ~5 s: the token appears in
`input[name="cf-turnstile-response"]` and better-auth sends it as the
`x-captcha-response` header. Just wait for the token before submitting.
Never return `CAPTCHA_UNSOLVABLE` for a Turnstile that is still solving, and
never try to click or bypass the widget.

**Confirmed on:** OpenHunts network (all five sites above).

## 4. hCaptcha visual challenges: use the official accessibility cookie — never solve

**Symptom.** hCaptcha escalates to an image-grid challenge on submit.

**Detection.** `iframe[src*="hcaptcha"]` / `.h-captcha` present and a visual
challenge appears (see `detectCaptcha` in `adapters/lib/common.js`).

**Solution.** hCaptcha runs an official accessibility program:

1. Sign up at `dashboard.hcaptcha.com/signup?type=accessibility`.
2. Verify the email (link lands in the inbox — poll it like any other
   verification mail).
3. Click "Set Cookie" **in the same browser context** the adapter uses
   (persistent profile).

After that, hCaptcha checkboxes auto-pass in that profile on every site. The
cookie expires — refresh it periodically. This is the sanctioned flow, not a
bypass, and it is the only acceptable way past visual challenges; adapters
must still never attempt to solve image grids.

**Confirmed on:** AlternativeTo (cookie then reusable for all hCaptcha sites).

## 5. Pre-selected paid upsells: deselect before every final submit

**Symptom.** A paid tier or skip-the-queue addon is pre-ticked by default;
the free path is hidden behind deselecting it.

**Confirmed cases.**
- Tiny Startups: "Skip the queue +£99" pre-selected; the "Submit for Free"
  button only appears after toggling it off.
- OpenHunts: $9.9 Premium skip-queue pre-selected on the plan step.
- Microlaunch: Pro $49 offered post-submit (decline = do nothing).

**Solution (adapter rule).** Before **any** final submit, enumerate checked
radios/checkboxes and selected cards whose text mentions a price or
"premium/pro/skip", deselect every paid one, and record what was deselected
in the transcript:

```js
const deselected = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('[aria-checked="true"], input:checked')) {
    const card = el.closest('label,div') || el;
    const t = (card.innerText || '').trim();
    if (/\$\s*[1-9]|£\s*[1-9]|premium|skip the queue/i.test(t) && t.length < 300) {
      el.click(); // radios: re-click the $0 option instead
      out.push(t.slice(0, 80));
    }
  }
  return out;
});
record('deselected_paid_options', deselected);
```

Spending money is a policy violation; "it was pre-checked" is not a defense.
Contract rule: `NEEDS_PAYMENT` if payment is truly required, but pre-selected
upsells are deselected, never paid.

## 6. Badge-gated free tiers: reciprocal badges unlock publication

**Symptom.** The free tier exists but publication (or queue-skipping) is
conditional on embedding the directory's badge on your product site.

**Detection.** Wording like "add our badge to skip the queue" or a
badge-verification step in the launch console.

**Solution.** Maintain a permanent `/partners` page plus footer badge slots
on the product site so adding a badge is a small, repeatable deploy. Two
verification styles exist:
- **Automated checker** — fetches the **root domain** only; a badge on a
  subpage alone does not count (Tiny Startups confirmed: footer badge on
  every page passes, `/partners` alone would not).
- **Manual review** — ~3 weeks (OpenHunts).

Budget for this in the campaign plan: badge deploys are product-site changes
and need the site owner's approval.

**Confirmed on:** Tiny Startups, OpenHunts; also required by Dang.ai,
Fazier, StartupBase.

## 7. Account-age gates: create the account on day one

**Symptom.** Submission is server-side blocked until the account reaches a
minimum age.

**Detection.** Modal/error like "New app submissions require an account age
of at least 7 days ... submit again after <date>". Not bypassable — it is
enforced server-side.

**Solution.** As soon as a directory with an age gate is identified, create
and email-verify the account immediately, then schedule the retry after the
window. The account-creation run and the submission run are separate
campaign steps, possibly weeks apart.

**Confirmed on:** AlternativeTo (7-day gate, hard-blocked until the exact
timestamp it quotes).

## 8. Wizard state volatility: one reload = start over

**Symptom.** A multi-step submit wizard loses everything if the page
reloads, the context closes, or navigation happens mid-flow.

**Detection.** No draft/resume affordance; URL doesn't change between steps;
state lives only in JS memory.

**Solution.** Drive the whole wizard in **one browser session with zero
reloads**: fill step by step, use in-page Next/Back buttons only, keep waits
generous instead of reloading "to be safe", and never recover from a stuck
step by refreshing — abort with `ERROR` and re-run from the top instead.

**Confirmed on:** OpenHunts submit wizard.

## 9. Chip/pill widgets: categories aren't buttons

**Symptom.** Category/platform pickers are clickable `div`s, not
`button`/`input` elements; standard label-based helpers miss them.

**Detection.** Options render as `div.cursor-pointer` pills; platform chips
may hold lowercase text inside `span.capitalize` (so the DOM says `web`
while the UI shows `Web`).

**Solution.** Match chips case-insensitively and click the pill container:

```js
for (const c of wantedCategories)
  await page.locator(`div.cursor-pointer:has-text("${c}")`).first()
    .click({ timeout: 4000 }).catch(() => record('chip_miss', c));
// lowercase-text chips:
await page.evaluate((wanted) => {
  document.querySelectorAll('span.capitalize').forEach(s => {
    if (wanted.includes(s.textContent.trim().toLowerCase()))
      s.closest('div.cursor-pointer')?.click();
  });
}, wantedPlatforms.map(p => p.toLowerCase()));
```

**Confirmed on:** OpenHunts (categories and platforms), common across
React/Tailwind directories.

## 10. Business-email-only forms, and phone-required forms

**Symptom.** Form rejects consumer email domains ("we only accept
work/business emails") or hard-requires a phone number.

**Detection.** Validation error on submit naming the email domain; or
"Phone Number cannot be blank" on a required step.

**Solution.** Provision a real mailbox on the product domain once (e.g.
`backlink@yourdomain.com` via Cloudflare Email Routing forwarding to the
campaign Gmail inbox — setup is minutes and free) and put it in
`product.json` as `contact_email_business`; adapters should prefer it over
`contact_email`. For phone: put a real, SMS-capable number in
`product.json`. **Never invent a phone number** — if it is empty, the
adapter returns `NEEDS_PHONE` (a Crozdesk/SoftwareSuggest precedent: the
number is verified or called, a fake one burns the listing).

**Confirmed on:** Startup Stash and SoftwareSuggest (business email gate,
cleared by the domain mailbox); SoftwareSuggest and Crozdesk (phone).

## 11. Magic-link / OTP email loops

**Symptom.** Login or verification happens via a link or code emailed to the
contact address.

**Solution.** Poll the campaign Gmail inbox with the package's email module
(`python -m backlink_agent verify-emails`), extract the link/OTP, and consume
it **in the same browser context** the adapter is driving (cookies/tokens
must land in the persistent profile). Links and codes are **single-use** —
never open one twice, never "test" it first; extract, navigate once, done.

**Confirmed on:** IndiePage (magic-link signup), SoftwareSuggest vendor
portal (email OTP), hCaptcha accessibility flow (pattern 4).

## 12. Guest submissions exist where accounts don't

**Symptom.** Account creation is paywalled or pointless, but a submission
path that needs no account exists.

**Detection.** "Register" leads to a paid club/membership, yet the directory
plugin (e.g. WPBDP on WordPress) exposes a public submit form.

**Solution.** Always check for a guest submit path **before** building auth
automation. On EU-Startups the WPBDP flow accepted a full free listing with
no account at all — the paid WP registration was a club product, unrelated
to listing. Skipping auth saves the whole OAuth/session problem when it
works.

**Confirmed on:** EU-Startups.
