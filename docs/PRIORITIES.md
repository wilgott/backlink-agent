# Directory priorities

The allowlist order is intentional: it is the default execution order for a
campaign, not a recommendation to submit everywhere. Re-check each target's
live page before submitting and keep the run small.

## Outpost16.com queue

This queue was distilled from the backlink-check screenshot supplied on
2026-09-16. It weighs observed authority, a public/indexable product page,
free-path availability, topical fit, and automation effort.

| Order | Directory | Why it is here | Guardrail |
| ---: | --- | --- | --- |
| 1 | Fazier | Highest reported authority in the screenshot; dofollow free path | Free path requires a reciprocal homepage/footer badge; paid checkout is optional and must not be entered without approval |
| 2 | Indie Hackers Products | High-authority founder audience and free product page | Product page is live; forum post is a separate optional outreach step |
| 3 | Findly | High reported authority and a product listing page | Free link may be nofollow; account and Turnstile are required |
| 4 | OpenHunts | Ahrefs-verified DR 67, dofollow, free, and an existing adapter | OAuth-only; deselect the preselected premium tier |
| 5 | Aura++ | Strong reported authority and a verified public product link | Free dofollow depends on the daily top-three or reciprocal badge; guaranteed dofollow is paid |
| 6 | The Hub | Dofollow Nordic startup profile with especially good Norway fit | Google/LinkedIn OAuth and company organization number required |
| 7 | Firsto | Relevant launch platform with a mixed link profile | Free queue is roughly 180 days; badge is required for the free dofollow path |
| 8 | PeerPush | Dofollow product page and free queue | Turnstile and passwordless account flow; decline paid upgrades |
| 9 | Twelve Tools | Public no-login flow and dofollow listing | Free path requires a reciprocal backlink; its score is 3, so the default score-4 gate intentionally blocks it until reviewed |

## Explicit exclusions from the screenshot

- **SmallLaunch** — the screenshot URL currently resolves to a GoDaddy domain
  sale page, not a directory.
- **LaunchMala** — the screenshot URL currently has no DNS resolution.

Do not add either domain to `allowed_sites` until a live, relevant submission
flow is independently verified.

## Confirmed listings

- **Twelve Tools** — Outpost16 is live at
  [twelve.tools/outpost16](https://twelve.tools/outpost16) as of 2026-09-16.
- **Indie Hackers** — Outpost16.com is live at
  [indiehackers.com/product/outpost16-com](https://www.indiehackers.com/product/outpost16-com) as of 2026-09-16.
- **Indie Hackers forum post** — Published at
  [After the pilot: help me sharpen Outpost16’s USP and moat](https://www.indiehackers.com/post/after-the-pilot-help-me-sharpen-outpost16-s-usp-and-moat-7d8e1301c5) as of 2026-09-16.

## Current run notes

- **Findly** — Submission form prepared for Outpost16 with the Analytics
  category and free plan, but not submitted. The required logo upload is
  still pending because the current Chrome session cannot attach the local
  file; resume at [findly.tools/submit](https://findly.tools/submit).
- **OpenHunts** — GitHub sign-in succeeded and the Outpost16 project form was
  auto-filled, but it was not submitted; resume at
  [openhunts.com/projects/submit](https://openhunts.com/projects/submit).

## Submission truthfulness

The landing page's `Featured On` section contains only reciprocal-badge
targets that are part of the current campaign setup. A directory must not be
described as a confirmed live listing until its public product URL has been
verified. Pending, rejected, and queued submissions remain pending in campaign
notes.
