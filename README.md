# backlink-agent

Automate product submissions to backlink directories. Built AI-agent-first:
an agent (Claude Code, Codex, ...) or a human on the CLI configures two JSON
files, reviews a plan, and lets the tool fill and submit directory forms with
Playwright — within the limits of an explicit allowlist.

It ships with a curated seed database of 134 directories, each scored for
automation feasibility, so you start from qualified targets instead of
discovery.

## What it does

- Loads a seed database of 134 directories (URL, submission method, cost,
  captcha, requirements, automation score 1–5).
- Evaluates every candidate site against your `settings.json` allowlist
  (fail-closed: any mismatch blocks the site with an explicit reason).
- Runs per-site Node.js Playwright adapters that fill submission forms using
  only data from your `product.json`.
- Records every attempt in a local SQLite database so re-runs skip
  already-submitted sites.
- Polls a Gmail inbox for verification emails and OTP codes after
  submissions that require them.

It does **not** do discovery, solve visual captchas, invent answers for form
fields, or act outside the allowlist.

## Prerequisites

- Python 3.10+
- Node.js 18+ (for the Playwright adapters)
- A Google Cloud OAuth client secret (only if you use email verification)

## Quick start

```bash
# 1. Install the Python package
pip install -e .

# 2. Install the adapter runtime
cd adapters && npm install && npx playwright install chromium && cd ..

# 3. Copy the examples and edit them
cp examples/settings.json .
cp examples/product.json .
# Edit product.json with your product's data, and settings.json with the
# sites/actions/data you want to allow. Create ./assets/ with the logo and
# screenshots referenced in product.json.

# 4. (Optional) authorize Gmail for email verification
cp .env.example .env   # fill in BACKLINK_AGENT_GMAIL_CLIENT_SECRET
python -m backlink_agent auth gmail

# 5. Review what would happen
python -m backlink_agent plan

# 6. Submit (start small)
python -m backlink_agent submit --limit 5

# 7. Handle verification emails
python -m backlink_agent verify-emails

# 8. See where things stand
python -m backlink_agent status

# 9. Generate the HTML dashboard
python -m backlink_agent report --open
```

## Dashboard

`python -m backlink_agent report` writes a self-contained HTML dashboard
(default `<log_dir>/report.html`, override with `--out`) joining the
directory database with the state DB: stat tiles, status/score
distributions, and a searchable, sortable per-site table. No external
dependencies — it opens straight from disk (`--open` launches it on macOS).

## The allowlist

The point of this tool is unattended operation without approving every tool
call. That works because the boundaries are declared up front in
`settings.json`:

```json
{
  "allowlist": {
    "max_submissions_per_run": 10,
    "min_automation_score": 4,
    "allowed_sites": ["Launching Next", "Startup Stash", "aitoolslist.io"],
    "allowed_costs": "free_only",
    "allowed_actions": ["form_post", "account_creation", "email_verification", "file_upload"],
    "allowed_personal_data": ["name", "email", "business_email", "phone"]
  }
}
```

A site is attempted only if it is named in `allowed_sites`, meets the
automation-score and cost limits, and every action and personal-data field
its submission flow requires is explicitly allowed and present in
`product.json`. Anything else is blocked with a reason. `plan` prints the
decision per site so you can review before submitting.

Field-by-field documentation: [examples/settings.schema.md](examples/settings.schema.md).
Rules for AI agents operating this repo: [docs/AGENTS.md](docs/AGENTS.md).

Running unattended without approval prompts: [docs/PERMISSIONS.md](docs/PERMISSIONS.md).

Field patterns from live campaigns (auth quirks, captcha flows, upsell traps): [docs/PATTERNS.md](docs/PATTERNS.md).

## Adapters

Each supported site has a Node.js Playwright adapter implementing the
contract in [docs/ADAPTER_CONTRACT.md](docs/ADAPTER_CONTRACT.md).

| Site | Adapter | Form engine | Status |
|---|---|---|---|
| Launching Next | `adapters/launching-next.js` | Plain HTML form + math captcha | MVP |
| Startup Stash | `adapters/startup-stash.js` | Typeform | MVP |
| aitoolslist.io | `adapters/aitoolslist.js` | Tally embed | MVP |
| OpenHunts | `adapters/openhunts.js` | better-auth wizard; needs a pre-authenticated OAuth profile; Turnstile auto-solves; deselects the pre-ticked paid tier | MVP |
| F6S | `adapters/f6s.js` | Email/password + reCAPTCHA v2 single click + 6-digit email OTP (one assisted step); company profile editor autosaves | MVP |
| DevHunt | `adapters/devhunt.js` | Next.js SPA; needs a GitHub OAuth profile; launch-week select gates the submit button; "$49" button creates the listing free (upsell backed out) | MVP |

To add a site: write `adapters/<site-slug>.js` per the contract, verify with
`adapter-test --dry-run`, then add the site to `allowed_sites`.

## Seed database

`data/directory-database.csv` contains 134 directories collected and
qualified during a real backlink campaign (klinky.io, July 2026). Each row
records the submission URL, directory category, DR estimate, link type
(dofollow/nofollow/mixed), submission method, cost, login/captcha
requirements, review time, field requirements, an automation score from 1
(manual only) to 5 (fully automatable public form), and notes from manual
inspection. `data/qualified-sites.json` is the same data in JSON form.

The scores and notes are a snapshot in time — sites change their forms,
pricing, and policies. Treat the database as a starting point and re-check
the notes before relying on them.

## Safety and limitations

- **Fail-closed allowlist.** The agent cannot act outside `settings.json`
  without you editing it.
- **No invented data.** Adapters answer only from `product.json`; missing
  fields produce `BLOCKED`/`NEEDS_*`, not guesses.
- **No visual captcha solving.** Sites that escalate to image challenges are
  reported, not bypassed.
- **Idempotency.** The SQLite state DB prevents duplicate submissions;
  `state/` and `logs/` are append-only and gitignored.
- **Directory rules still apply.** Many directories review submissions
  manually and reject off-topic or low-quality listings. Check fit before
  allowlisting a site; a rejection or flag is worse than skipping.
- Email verification reads only senders matching `allowed_sender_patterns`.

## Contributing

- New adapters: follow [docs/ADAPTER_CONTRACT.md](docs/ADAPTER_CONTRACT.md)
  and include a `--dry-run` mode that fills but does not submit.
- Seed database corrections (dead sites, changed costs, new scores) are
  welcome — include the evidence.
- Run `pytest` before submitting changes to the Python core.

## License

MIT — see [LICENSE](LICENSE). Copyright 2026 Robin Wilgott.
