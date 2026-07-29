# settings.json field reference

JSON does not support comments, so every field in `settings.json` is
documented here. See `examples/settings.json` for a working template.

## Top level

| Field | Type | Description |
|---|---|---|
| `version` | int | Schema version of the settings file. Currently `1`. |
| `product_profile_path` | string | Path to your `product.json`, relative to the working directory. |
| `state_db` | string | Path to the SQLite idempotency database. Created on first run. Gitignored. |
| `log_dir` | string | Directory for run logs and adapter artifacts (screenshots, transcripts). Gitignored. |
| `token_dir` | string | Directory where OAuth tokens are stored (e.g. the Gmail token). Defaults to `~/.config/backlink-agent`. |

## `allowlist`

The allowlist is the safety core of the tool. Every candidate site is
evaluated against it before any browser action; any mismatch fails closed
(`BLOCKED_BY_ALLOWLIST`) with an explicit reason.

| Field | Type | Description |
|---|---|---|
| `max_submissions_per_run` | int | Hard cap on submissions in a single `submit` run, regardless of how many sites pass the allowlist. |
| `min_automation_score` | int (1–5) | Minimum `automation_score` a directory must have in the seed database to be attempted. 5 = fully automatable public form; 1 = manual only. |
| `allowed_sites` | string[] | Explicit site-name allowlist. A site must appear here (exact name as in `data/directory-database.csv`) to be attempted. An empty list means nothing is allowed. |
| `blocked_sites` | string[] | Explicit denylist. Wins over `allowed_sites` if a name appears in both. |
| `allowed_costs` | string | `free_only`: only directories whose cost is free. `free_and_paid_up_to_x`: also allow paid directories up to `max_paid_usd`. |
| `max_paid_usd` | number | Maximum one-time/review fee in USD allowed when `allowed_costs` is `free_and_paid_up_to_x`. Ignored under `free_only`. |
| `allowed_actions` | string[] | Action types the agent may perform. Recognized values: `form_post`, `account_creation`, `email_verification`, `file_upload`, `payment`, `oauth`. A site whose submission flow requires an action not listed here is blocked. |
| `allowed_personal_data` | string[] | Personal data fields the agent may enter into forms. Recognized values: `name`, `email`, `business_email`, `phone`. A site requiring a field not listed here (or listed but with no value in `product.json`) is blocked. |
| `allowed_hours_utc` | object or null | Optional submission window, e.g. `{"start": 6, "end": 22}`. `null` = no time restriction. |

## `email`

Used by `verify-emails` to poll a mailbox for verification links and OTP
codes after submissions.

| Field | Type | Description |
|---|---|---|
| `enabled` | bool | Master switch. When `false`, `verify-emails` does nothing. |
| `provider` | string | Mail provider. Currently only `gmail` is supported. |
| `poll_interval_seconds` | int | Delay between inbox polls while waiting for a verification mail. |
| `max_wait_minutes` | int | Give up waiting for a verification mail after this many minutes. |
| `allowed_sender_patterns` | string[] | Regex patterns; only mail from matching senders is opened/acted on. `[".*"]` allows any sender — narrow this for stricter setups. |

## Secrets

Secrets never go in `settings.json`. Gmail OAuth credentials are referenced
via environment variables (see `.env.example`):

- `BACKLINK_AGENT_GMAIL_CLIENT_SECRET` — path to the Google OAuth client-secret JSON.
- `BACKLINK_AGENT_GMAIL_TOKEN_PATH` — where the authorized token is cached.
