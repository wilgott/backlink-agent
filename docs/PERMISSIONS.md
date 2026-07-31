# Permissions — running unattended without approval prompts

The whole point of backlink-agent is that a human sets policy **once** (in
`settings.json` + `product.json`) and the agent then runs unattended. The same
idea applies to the agent harness itself: pre-approve the tool calls the run
will need, or you will be babysitting permission prompts.

This file is the reference allowlist we run with. It goes in your **user-level**
`~/.claude/settings.json` under `permissions.allow` (user-level, not project
`settings.local.json`, so it applies to every project — including fresh clones
of this repo).

## Recommended `permissions.allow`

```json
[
  "Bash(node:*)",
  "Bash(python3:*)",
  "Bash(python:*)",
  "Bash(.venv/bin/python:*)",
  "Bash(npx:*)",
  "Bash(npm install:*)",
  "Bash(pip3 install:*)",
  "Bash(curl *)",
  "Bash(mkdir:*)",
  "Bash(cp:*)",
  "Bash(mv:*)",
  "Bash(rm:*)",
  "Bash(ln:*)",
  "Bash(touch:*)",
  "Bash(cat:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
  "Bash(sed:*)",
  "Bash(awk:*)",
  "Bash(jq:*)",
  "Bash(grep:*)",
  "Bash(find:*)",
  "Bash(ls:*)",
  "Bash(sort:*)",
  "Bash(uniq:*)",
  "Bash(cut:*)",
  "Bash(diff:*)",
  "Bash(wc:*)",
  "Bash(date:*)",
  "Bash(sleep:*)",
  "Bash(echo:*)",
  "Bash(which:*)",
  "Bash(chmod:*)",
  "Bash(sips:*)",
  "Edit(//<absolute-path-to-your-projects>/**)",
  "Write(//<absolute-path-to-your-projects>/**)",
  "WebFetch",
  "Bash(git add:*)", "Bash(git commit:*)", "Bash(git push:*)",
  "Bash(git fetch:*)", "Bash(git worktree:*)", "Bash(git checkout:*)",
  "Bash(git branch:*)", "Bash(git status:*)", "Bash(git diff:*)",
  "Bash(git log:*)", "Bash(git stash:*)", "Bash(git merge:*)",
  "Bash(gh run *)", "Bash(gh api *)",
  "Bash(base64:*)", "Bash(file:*)", "Bash(stat:*)",
  "mcp__playwright__browser_run_code_unsafe",
  "mcp__playwright__browser_tabs",
  "mcp__playwright__browser_press_key",
  "mcp__playwright__browser_type",
  "mcp__playwright__browser_fill_form",
  "mcp__playwright__browser_evaluate",
  "mcp__playwright__browser_take_screenshot",
  "mcp__playwright__browser_snapshot",
  "mcp__playwright__browser_click",
  "mcp__playwright__browser_navigate",
  "mcp__playwright__browser_console_messages",
  "mcp__playwright__browser_network_requests",
  "mcp__playwright__browser_close",
  "mcp__playwright__browser_navigate_back",
  "mcp__playwright__browser_wait_for",
  "mcp__playwright__browser_resize",
  "mcp__playwright__*",
  "mcp__cloudflare__*",
  "mcp__playwright__browser_select_option",
  "mcp__playwright__browser_handle_dialog",
  "mcp__playwright__browser_hover",
  "mcp__playwright__browser_navigate_forward",
  "Bash(rsync:*)",
  "Bash(pkill:*)",
  "Bash(lsof:*)",
  "Bash(tar:*)",
  "Bash(unzip:*)",
  "Bash(zip:*)",
  "Bash(open:*)",
  "Read(//tmp/**)",
  "Read(//~/.config/**)",
  "Read(//~/Downloads/**)",
  "Write(//tmp/**)",
  "Edit(//tmp/**)",
  "Bash(cd:*)",
  "Bash(gh pr *)", "Bash(gh issue *)", "Bash(gh release *)",
  "Bash(sqlite3:*)", "Bash(ps:*)", "Bash(tr:*)", "Bash(tee:*)",
  "Bash(xargs:*)", "Bash(column:*)", "Bash(pbcopy:*)", "Bash(pbpaste:*)",
  "Bash(osascript:*)",
  "Bash(defaults:*)",
  "Bash(plutil:*)",
  "Bash(killall:*)",
  "Bash(mdfind:*)",
  "Bash(xattr:*)",
  "mcp__playwright__browser_run_code",
  "mcp__playwright__browser_find",
  "mcp__playwright__browser_drop",
  "mcp__playwright__browser_network_request"
]
```

## Why each group

| Group | Why the run needs it |
|---|---|
| `node` / `python3` / `.venv/bin/python` | Adapter scripts and the package CLI. |
| `npx` / `npm install` / `pip install` | Playwright + browser install, Python deps. |
| `curl` | Form recon (headers, redirects, captcha detection). |
| `mkdir` `cp` `mv` `rm` `ln` `touch` | Work dirs, screenshot moves, state cleanup every run. |
| `cat` `head` `tail` `sed` `awk` `jq` `grep` `find` `sort` `uniq` `cut` `diff` `wc` | Reading form HTML, parsing JSON API responses, updating the directory database. |
| `date` `sleep` | Log timestamps; polling between email-verification checks. |
| `sips` | Resizing logos when a site demands a specific pixel size. |
| `Write`/`Edit` on `/tmp` | Agents stage scripts, screenshots, and state dumps in /tmp constantly. |
| `Read` on `~/Downloads` | OAuth client-secret files typically live there (Gmail setup). |
| macOS utils (`osascript`, `defaults`, `plutil`, `killall`, `mdfind`, `xattr`) | Browser/profile housekeeping on macOS. |
| `Edit`/`Write` on your projects dir | Agents write adapter scripts, logs, and state files constantly. Scope to your projects root, not `/`. |
| Playwright MCP extras | `file_upload` (logo/screenshot uploads), `select_option` (category dropdowns), `handle_dialog` (confirm dialogs). These prompt on nearly every submission without the rules. |

## Lessons baked into this list

1. **Compound commands defeat allow rules.** `Bash(node:*)` does NOT cover
   `cat > script.mjs << 'EOF' ... EOF && node script.mjs` — the heredoc compound
   prompts as a unit. Write scripts with the file-writing tool instead, then run
   them as single commands. Single-purpose commands pass; compounds prompt.
2. **Edit/Write are separate permission domains.** Allowing `Bash` does nothing
   for file-edit prompts. Add explicit `Edit(...)`/`Write(...)` path rules.
3. **MCP tools are per-tool rules — so use the server wildcard.** `mcp__playwright__browser_navigate` does
   not imply `mcp__playwright__browser_file_upload`. Listing tools one by one is whack-a-mole:
   `mcp__playwright__*` covers the whole server, including tools added in future versions.
4. **WebFetch is per-domain unless you allow it bare.** New directory domains prompt every time during recon; a bare `WebFetch` rule is read-only and kills the whole class.
5. **Git is per-subcommand.** `git commit` does not imply `git worktree` or `git stash`. Push-driven deploy flows need `git push` — note it also permits `--force`; split it out if that matters to you.
6. **Env-prefixed commands break prefix rules.** `NODE_PATH=... node x.js` does NOT match `Bash(node:*)` — the env assignment changes the command head. Use absolute imports in ESM scripts (`import ... from '/abs/path/node_modules/playwright/index.mjs'`) instead of NODE_PATH. Same class: `VAR=1 python3 ...`.
7. **Profile cloning needs `rsync`; process inspection needs `pkill`/`lsof`.** The locked-profile workaround (rsync minus Singleton*) and stale-Chromium cleanup prompt without these.
8. **Heredocs and shell loops are un-fixable by rules.** `cat > f << 'EOF'` and `for i in ...` prompt as compound units no matter how broad your Bash rules are. The fix is behavioral: write files with the file-writing tool, loop in Python/Node, run one command at a time. Put this rule in every agent brief.
9. **User-level > project-level for this file.** Project `settings.local.json`
   only helps one repo; the same agents run across many.
7. **Keep the blast radius conscious.** `node:*`, `python3:*`, `rm:*`, `curl *`
   together are arbitrary code execution + deletion. That is the accepted trade
   for unattended runs — mitigate by *not* adding deploy/push/destructive rules
   (keep `git push`, `wrangler deploy`, payment flows manual or per-project).

10. **A missing small head poisons every compound.** `cd` was absent from this
   list for weeks; every `cd /repo && pytest -q` prompted the human even though
   `pytest` was allowed — compound commands are re-evaluated as units, so the
   smallest unlisted member decides. Audit what agents actually ran (transcript
   JSONLs under the session tasks dir) and add the mundane heads: `cd`, `ps`,
   `tr`, `tee`, `xargs`, `sqlite3`, `pbcopy/pbpaste`. Then eliminate the
   compounds themselves per lesson 8 (`git -C`, `npm --prefix`, absolute paths,
   sleeps inside scripts).

## When an agent still asks for something

Treat it as a policy gap, not a one-off: **add the rule to settings.json
directly and proceed** — do not wait for a human to approve prompts one by
one. Only pause for a human when the permission is genuinely risky: `sudo`,
payments/purchases, reading private credentials outside the agreed stores,
force-push, account deletion, or anything irreversible. Everything else
(reads, writes inside the projects dir, browser automation, package installs,
git plumbing, API calls) gets added and the run continues.
