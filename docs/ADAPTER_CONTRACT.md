# Adapter Contract

Formal specification for the per-site Node.js submission adapters. The Python
runner (`backlink_agent/adapters/runner.py`) and every adapter under
`adapters/` must conform to this document exactly. **Do not change key names
without changing both sides.**

## 1. Invocation

```bash
node adapters/<site-slug>.js <input.json> <output.json>
```

- `argv[2]` — path to a JSON file containing the run input (read-only for the adapter).
- `argv[3]` — path the adapter must write its result JSON to.
- Working directory is the repo root; relative paths in the input are
  relative to it.
- The adapter process **exits 0 on every completed run**, including failed
  submissions. The outcome is carried by `status` in the output file. A
  non-zero exit is reserved for contract violations (unreadable/unparseable
  input, unwritable output path) and signals an adapter bug, not a
  submission failure.
- The adapter must always terminate. It must never hang waiting for human
  input, captcha solving, or network. Use bounded timeouts everywhere
  (suggested: 45 s navigation, 5 s element actions) and fail with a reason.

## 2. Input schema (`input.json`)

```json
{
  "run_id": "3f2b8c1e-...",
  "site": {
    "name": "Launching Next",
    "submission_url": "https://www.launchingnext.com/submit/",
    "automation_score": 5,
    "...": "any other column from data/directory-database.csv, passed through verbatim"
  },
  "product": {
    "name": "Acme",
    "website": "https://acme.example",
    "tagline_39": "...",
    "tagline_50": "...",
    "tagline_66": "...",
    "tagline_111": "...",
    "description_145": "...",
    "description_150": "...",
    "description_505": "...",
    "description_1341": "...",
    "description_2192": "...",
    "categories": ["Marketing", "Analytics"],
    "tags": ["saas", "analytics", "..."],
    "logo": "./assets/logo-512.png",
    "screenshots": ["./assets/screenshot-1.png"],
    "founder_name": "Jane Doe",
    "founder_linkedin": "https://www.linkedin.com/in/janedoe",
    "founder_github": "https://github.com/janedoe",
    "contact_email": "jane.doe@gmail.com",
    "contact_email_business": "press@acme.example",
    "phone": "+47..."
  },
  "paths": {
    "screenshot_dir": "./logs/2026-07-29/launching-next/",
    "user_data_dir": "./state/profiles/launching-next"
  },
  "headless": true,
  "dry_run": false
}
```

Field semantics:

| Key | Type | Notes |
|---|---|---|
| `run_id` | string | UUID for this run; echo it in the transcript. |
| `site` | object | Full directory-database row plus `submission_url`. Only `submission_url` is guaranteed non-empty; read everything else defensively. |
| `product.*` | | All product data the adapter may use. **Nothing else may be invented.** Tagline/description suffixes are their approximate character budgets. Optional keys (`phone`, `founder_github`, ...) may be empty strings. |
| `paths.screenshot_dir` | string | Directory the adapter creates and writes screenshots + `transcript.json` into. |
| `paths.user_data_dir` | string | Persistent Chromium profile dir for this site (cookies survive runs). |
| `headless` | boolean | Default true when absent. |
| `dry_run` | boolean | When true: fill everything, stop before the final submit, return `DRY_RUN`. **Mandatory for every adapter.** |

## 3. Output schema (`output.json`)

```json
{
  "status": "SUBMITTED",
  "reason": "",
  "confirmation_text": "Thank you for applying to get listed...",
  "submitted_at": "2026-07-29T08:15:00.000Z",
  "email_verification": null,
  "requested_action": null,
  "links_found": ["https://example.com/listing/acme"],
  "artifacts": {
    "screenshots": ["logs/.../01-form-loaded.png", "logs/.../02-filled.png"],
    "transcript": "logs/.../transcript.json"
  }
}
```

### 3.1 `status` enum (closed set)

| Status | Meaning | Runner behavior |
|---|---|---|
| `SUBMITTED` | Form submitted and confirmation observed. | Record success; skip on future runs. |
| `ALREADY_SUBMITTED` | Site reports this product/URL is already listed or submitted. | Record success; skip on future runs. |
| `NEEDS_EMAIL_VERIFICATION` | Submitted, but the site says it emailed a verification link/OTP that must be confirmed. | Queue for `verify-emails` using the `email_verification` block. |
| `NEEDS_PAYMENT` | Payment is required to complete the submission. | Surface to user; adapter must never pay. |
| `NEEDS_PHONE` | A phone number is hard-required and `product.phone` is empty/unusable. | Surface to user. |
| `NEEDS_OAUTH` | Login via Google/GitHub/LinkedIn etc. is required and no session exists in `user_data_dir`. | Surface to user for a one-time manual login. |
| `BLOCKED` | The site refused or the adapter lacks required data (e.g. business-only email, missing product field, no acceptable category). Not retryable without changes. | Surface reason to user. |
| `CAPTCHA_UNSOLVABLE` | A visible captcha (reCAPTCHA, hCaptcha, Turnstile) blocks progress. Math/text captchas the adapter can solve do NOT use this status. | Retryable later with a warmed profile. |
| `ERROR` | Anything else: unexpected page, selector rot, validation failure, exception. `reason` must say what happened. | Retryable with backoff. |
| `DRY_RUN` | `dry_run` was true; everything was filled, final submit intentionally not performed. | Verification only; not recorded as submitted. |

### 3.2 Other fields

| Key | Type | Notes |
|---|---|---|
| `reason` | string | Empty on success; otherwise a human/agent-readable explanation of the status. Required for `BLOCKED`, `ERROR`, `CAPTCHA_UNSOLVABLE`, `NEEDS_*`. |
| `confirmation_text` | string \| null | Verbatim confirmation snippet from the site after submit (truncated to ~800 chars). |
| `submitted_at` | string \| null | ISO-8601 UTC timestamp; set iff `SUBMITTED`. |
| `email_verification` | object \| null | `{ "expected_sender_pattern": "startupstash", "expected_subject_pattern": "get listed", "max_wait_minutes": 30 }`. Regex fragments matched case-insensitively by the runner's email poller. Set iff status is `NEEDS_EMAIL_VERIFICATION`, otherwise `null`. |
| `requested_action` | object \| null | `{ "action": "payment" \| "phone" \| "oauth_login" \| "provide_business_email" \| "other", "details": "..." }` — what a human must do to unblock. Set for `NEEDS_*`/`BLOCKED` when actionable, otherwise `null`. |
| `links_found` | string[] | URLs observed during the run that point at the product's listing/confirmation page. Empty array if none. |
| `artifacts.screenshots` | string[] | Absolute paths of numbered screenshots, in order. |
| `artifacts.transcript` | string \| null | Absolute path to `<screenshot_dir>/transcript.json`: an array of `{ "step": "...", "at": "<ISO>", "detail": {...} }` entries covering every meaningful action. |

## 4. Adapter rules

1. **No hardcoded product data.** Every value typed into a form comes from
   `input.product`. If a required value is missing, return `BLOCKED` with a
   reason — never invent names, emails, phone numbers, or descriptions.
2. **Fail, don't hang.** Every wait has a timeout; every flow has a max step
   count; stuck-detection aborts with `ERROR`.
3. **`dry_run` support is mandatory.** Fill the entire form, screenshot it,
   return `DRY_RUN` before the final submit click.
4. **Never pay and never create accounts** unless the site's directory row
   (passed in `site`) implies it and the run was pre-approved through the
   Python allowlist. When payment or account creation appears unexpectedly,
   stop with `NEEDS_PAYMENT` / `NEEDS_OAUTH` and a `requested_action`.
5. **Never solve visual captchas.** Detect reCAPTCHA / hCaptcha / Turnstile
   (`detectCaptcha` in `adapters/lib/common.js`) and return
   `CAPTCHA_UNSOLVABLE`. Simple text/math questions may be answered.
6. **Use the persistent profile** at `paths.user_data_dir`
   (`chromium.launchPersistentContext`) so login sessions survive runs.
7. **Screenshots + transcript for every run.** Numbered screenshots at each
   meaningful step and a `transcript.json` in `paths.screenshot_dir`. These
   are the audit trail for unattended runs.
8. **Only touch the site's submission flow.** Do not subscribe to
   newsletters, opt into marketing, agree to paid promotion, or click
   unrelated offers. Uncheck pre-checked marketing checkboxes when the
   contact address would be subscribed.
9. **Confirmation requires evidence.** Only return `SUBMITTED` when the site
   shows a confirmation/thank-you state after the final submit. "No error
   occurred" is not evidence.

## 5. Shared helpers

`adapters/lib/common.js` implements the mechanics of this contract:
`readInput`, `initRun`, `launchBrowser`, `shot`, `record`, `finish`,
`runAdapter` (exception → `ERROR`), `fillByLabel`, `clickByText`,
`checkRadioByLabelText`, `labelTextFor`, `detectCaptcha`, plus text
utilities (`firstPresent`, `trimTo`, `trimWords`, `missingField`). New
adapters should import these rather than re-implement them.
