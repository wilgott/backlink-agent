# backlink-agent

[![GitHub stars](https://img.shields.io/github/stars/wilgott/backlink-agent?style=flat)](https://github.com/wilgott/backlink-agent/stargazers)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Python 3.10+](https://img.shields.io/badge/python-3.10%2B-blue.svg)](https://www.python.org/)

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

## Agent fast path

If you are an AI agent operating this repo, the short path is:

1. Merge [examples/claude-code-allowlist.json](examples/claude-code-allowlist.json)
   into `~/.claude/settings.json` `permissions.allow` (no approval prompts).
2. Read [docs/AGENTS.md](docs/AGENTS.md) (operating rules) and
   [docs/CHEATSHEET.md](docs/CHEATSHEET.md) (all field patterns, one line each).
3. Look up each target in [data/recipes.json](data/recipes.json) — proven
   auth/form/captcha/paid-trap handling for the sites already executed
   end-to-end. Recon only sites without a recipe.
4. `plan`, then `submit --limit 5`, then `verify-emails`, then `report`.

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

Running unattended without approval prompts: [docs/PERMISSIONS.md](docs/PERMISSIONS.md) — or merge the ready-made [examples/claude-code-allowlist.json](examples/claude-code-allowlist.json) into `~/.claude/settings.json` `permissions.allow` and you will not be prompted again.

Field patterns from live campaigns (auth quirks, captcha flows, upsell traps): [docs/CHEATSHEET.md](docs/CHEATSHEET.md) (compact) or [docs/PATTERNS.md](docs/PATTERNS.md) (full prose).

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
qualified during a real SaaS backlink campaign (July 2026). Each row
records the submission URL, directory category, DR estimate, link type
(dofollow/nofollow/mixed), submission method, cost, login/captcha
requirements, review time, field requirements, an automation score from 1
(manual only) to 5 (fully automatable public form), and execution-grade
notes. `data/qualified-sites.json` is the same data in JSON form
(regenerate with `python3 scripts/build-data-json.py` after editing the
CSV). `data/recipes.json` holds per-site execution recipes (auth type,
form engine, captcha, paid traps, proven handling) for the sites already
driven end-to-end.

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

## Support the project

If backlink-agent saved you a weekend of directory forms, the most helpful
things you can do:

- **Star the repo** — [github.com/wilgott/backlink-agent](https://github.com/wilgott/backlink-agent).
  Stars decide whether this stays maintained.
- **Link back** — if the tool earned you listings, a link helps the next
  founder find it. Drop the badge in your footer or README:

  ```html
  <a href="https://github.com/wilgott/backlink-agent" target="_blank" rel="noopener">
    <img src="https://raw.githubusercontent.com/wilgott/backlink-agent/main/badges/powered-by-backlink-agent.svg"
         alt="Powered by backlink-agent" width="200" height="54">
  </a>
  ```

  (SVG also lives at [`badges/powered-by-backlink-agent.svg`](badges/powered-by-backlink-agent.svg) if you prefer to self-host.)

- **Share your run** — issues and discussions with what worked / what broke
  on which directory feed the patterns docs for everyone.

## License

MIT — see [LICENSE](LICENSE). Copyright 2026 Robin Wilgott.
