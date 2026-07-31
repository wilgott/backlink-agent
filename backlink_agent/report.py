"""Self-contained HTML dashboard of submission state.

Renders the directory database joined with the state DB into a single
``.html`` file — embedded JSON + vanilla JS, no CDN, works from ``file://``.
Stdlib only.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

from backlink_agent.directories import Site

# Display metadata for the runner status vocabulary (adapters/runner.py),
# plus NOT_ATTEMPTED for sites with no state row.
NOT_ATTEMPTED = "NOT_ATTEMPTED"

STATUS_META: dict[str, dict[str, str]] = {
    "SUBMITTED": {"label": "Submitted", "cls": "b-green"},
    "ALREADY_SUBMITTED": {"label": "Already listed", "cls": "b-green"},
    "NEEDS_EMAIL_VERIFICATION": {"label": "Needs email verification", "cls": "b-amber"},
    "NEEDS_PAYMENT": {"label": "Needs payment", "cls": "b-amber"},
    "NEEDS_PHONE": {"label": "Needs phone", "cls": "b-amber"},
    "NEEDS_OAUTH": {"label": "Needs OAuth", "cls": "b-amber"},
    "BLOCKED": {"label": "Blocked", "cls": "b-red"},
    "ERROR": {"label": "Error", "cls": "b-red"},
    "NO_ADAPTER": {"label": "No adapter", "cls": "b-zinc"},
    "DRY_RUN": {"label": "Dry run", "cls": "b-zinc"},
    NOT_ATTEMPTED: {"label": "Not attempted", "cls": "b-zinc"},
}

_SUBMITTED_STATUSES = ("SUBMITTED",)
_VERIFIED_STATUSES = ("ALREADY_SUBMITTED",)
_PENDING_STATUSES = (
    "NEEDS_EMAIL_VERIFICATION",
    "NEEDS_PAYMENT",
    "NEEDS_PHONE",
    "NEEDS_OAUTH",
    "BLOCKED",
    "ERROR",
)
_SKIPPED_STATUSES = ("NO_ADAPTER", "DRY_RUN")


def _note_from_record(rec: Mapping[str, Any]) -> str:
    """Best-effort human note: adapter reason, else confirmation text."""
    outcome = rec.get("outcome")
    if isinstance(outcome, Mapping):
        reason = outcome.get("reason")
        if reason:
            return str(reason)
    confirmation = rec.get("confirmation_text")
    return str(confirmation) if confirmation else ""


def build_rows(
    sites: Sequence[Site],
    state: Any,
) -> list[dict[str, Any]]:
    """Join the directory database with state records, one row per site.

    ``state`` is anything with a ``.get(site_name)`` accessor returning a
    state record dict or None — a ``StateStore`` or a plain dict both work.
    """
    rows: list[dict[str, Any]] = []
    for site in sites:
        rec = state.get(site.name) or {}
        status = str(rec.get("status") or NOT_ATTEMPTED)
        meta = STATUS_META.get(status, {"label": status.replace("_", " ").title(), "cls": "b-zinc"})
        rows.append(
            {
                "name": site.name,
                "url": site.url,
                "category": site.category,
                "dr": site.dr_estimate,
                "link_type": site.link_type,
                "score": site.automation_score,
                "status": status,
                "status_label": meta["label"],
                "status_cls": meta["cls"],
                "last_attempt": (rec.get("last_attempt_at") or "")[:10],
                "retry_count": int(rec.get("retry_count") or 0),
                "submitted_url": rec.get("submitted_url") or "",
                "notes": _note_from_record(rec) or site.automation_notes,
            }
        )
    return rows


def summarize(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Headline counts for the stat tiles."""

    def n(*statuses: str) -> int:
        return sum(1 for r in rows if r["status"] in statuses)

    return {
        "total": len(rows),
        "submitted": n(*_SUBMITTED_STATUSES),
        "verified": n(*_VERIFIED_STATUSES),
        "pending": n(*_PENDING_STATUSES),
        "skipped": n(*_SKIPPED_STATUSES),
        "not_attempted": n(NOT_ATTEMPTED),
    }


_HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>__TITLE__</title>
<style>
:root{
  --bg:#09090b; --card:#111113; --card2:#18181b; --border:#27272a; --border2:#3f3f46;
  --text:#fafafa; --muted:#a1a1aa; --faint:#71717a;
  --green:#4ade80; --green-d:#052e16; --blue:#60a5fa; --blue-d:#172554;
  --amber:#fbbf24; --amber-d:#451a03; --red:#f87171; --red-d:#450a0a;
  --zinc:#d4d4d8; --zinc-d:#27272a;
  --mono:ui-monospace,'SF Mono',Menlo,Consolas,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:24px;max-width:1440px;margin:0 auto}
a{color:var(--blue);text-decoration:none}
h1{font-size:22px;font-weight:700;letter-spacing:-0.02em}
.sub{color:var(--muted);font-size:13px;margin-top:4px}
header{margin-bottom:20px}
.grid{display:grid;gap:12px}
.tiles{grid-template-columns:repeat(auto-fit,minmax(160px,1fr));margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px}
.tile .num{font-size:30px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-0.02em}
.tile .lbl{color:var(--muted);font-size:12px;margin-top:2px}
.badge{display:inline-flex;align-items:center;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap;border:1px solid transparent}
.b-green{background:var(--green-d);color:var(--green);border-color:#14532d}
.b-blue{background:var(--blue-d);color:var(--blue);border-color:#1e3a8a}
.b-amber{background:var(--amber-d);color:var(--amber);border-color:#78350f}
.b-red{background:var(--red-d);color:var(--red);border-color:#7f1d1d}
.b-zinc{background:var(--zinc-d);color:var(--zinc);border-color:var(--border2)}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em;font-weight:600;padding:8px 10px;border-bottom:1px solid var(--border);cursor:pointer;user-select:none;white-space:nowrap}
th:hover{color:var(--text)}
th .arrow{font-size:9px;margin-left:3px}
td{padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:top}
tbody tr:hover{background:var(--card2)}
.tblwrap{background:var(--card);border:1px solid var(--border);border-radius:10px;overflow:auto}
.controls{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;align-items:center}
input[type=search],select{background:var(--card);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:7px 12px;font-size:13px;outline:none}
input[type=search]{min-width:240px}
input[type=search]:focus,select:focus{border-color:var(--border2)}
.count{color:var(--faint);font-size:12px;margin-left:auto}
.bar-row{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.bar-row .k{width:150px;font-size:12px;color:var(--muted);text-align:right;flex-shrink:0}
.bar-track{flex:1;background:var(--card2);border-radius:5px;height:20px;overflow:hidden;border:1px solid var(--border)}
.bar-fill{height:100%;border-radius:4px}
.bar-row .v{width:44px;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.section-title{font-size:14px;font-weight:600;margin:22px 0 10px}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:900px){.two-col{grid-template-columns:1fr}}
.mono{font-family:var(--mono);font-size:11px}
.note{color:var(--faint);font-size:12px;margin-top:14px}
.truncate{max-width:380px}
footer{margin-top:28px;color:var(--faint);font-size:11px;border-top:1px solid var(--border);padding-top:14px}
</style>
</head>
<body>
<header>
  <h1>__TITLE__</h1>
  <div class="sub">Generated __GENERATED__ &middot; __TOTAL__ sites in directory database</div>
</header>

<div class="grid tiles" id="tiles"></div>

<div class="two-col">
  <div class="card">
    <div class="section-title" style="margin-top:0">Status distribution</div>
    <div id="statusbars"></div>
  </div>
  <div class="card">
    <div class="section-title" style="margin-top:0">Automation score distribution</div>
    <div id="scorebars"></div>
    <div class="note">Score 5 = pure form POST &middot; 4 = agent-executable with account/OAuth &middot; 3 = one hard checkpoint &middot; 2 = human/community-gated &middot; 1 = no-go</div>
  </div>
</div>

<div class="section-title">Sites</div>
<div class="controls">
  <input type="search" id="q" placeholder="Search sites&hellip;">
  <select id="f-status"><option value="">All statuses</option></select>
  <select id="f-score"><option value="">All scores</option><option>5</option><option>4</option><option>3</option><option>2</option><option>1</option><option>0</option></select>
  <select id="f-cat"><option value="">All categories</option></select>
  <span class="count" id="count"></span>
</div>
<div class="tblwrap" style="max-height:72vh"><table>
  <thead><tr id="head"></tr></thead>
  <tbody id="body"></tbody>
</table></div>

<footer>Self-contained report &middot; no external dependencies &middot; generated by <a href="https://github.com/wilgott/backlink-agent" target="_blank" rel="noopener">backlink-agent</a> &middot; useful? &#9733; <a href="https://github.com/wilgott/backlink-agent" target="_blank" rel="noopener">star the repo</a></footer>

<script id="report-data" type="application/json">__DATA__</script>
<script>
const DATA = JSON.parse(document.getElementById('report-data').textContent);
const esc = s => String(s??'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const trunc = (s,n) => { s = String(s||''); return s.length>n ? s.slice(0,n-1)+'…' : s; };
const rows = DATA.rows;

// ---------- stat tiles ----------
const S = DATA.summary;
const tiles = [
  {num:S.total,        lbl:'Sites in database',  color:'var(--text)'},
  {num:S.submitted,    lbl:'Submitted',          color:'var(--green)'},
  {num:S.verified,     lbl:'Already listed',     color:'var(--green)'},
  {num:S.pending,      lbl:'Pending / blocked',  color:'var(--amber)'},
  {num:S.skipped,      lbl:'Skipped',            color:'var(--zinc)'},
  {num:S.not_attempted,lbl:'Not attempted',      color:'var(--faint)'},
];
document.getElementById('tiles').innerHTML = tiles.map(t =>
  `<div class="card tile"><div class="num" style="color:${t.color}">${t.num}</div><div class="lbl">${esc(t.lbl)}</div></div>`).join('');

// ---------- distribution bars (single hue per chart, labelled rows, no legend) ----------
function bars(el, entries, color){
  const max = Math.max(1, ...entries.map(e => e.c));
  document.getElementById(el).innerHTML = entries.map(e =>
    `<div class="bar-row"><span class="k">${esc(e.label)}</span><div class="bar-track"><div class="bar-fill" style="width:${e.c/max*100}%;background:${color(e)}"></div></div><span class="v">${e.c}</span></div>`).join('');
}
const statusOrder = ['SUBMITTED','ALREADY_SUBMITTED','NEEDS_EMAIL_VERIFICATION','NEEDS_PAYMENT','NEEDS_PHONE','NEEDS_OAUTH','BLOCKED','ERROR','NO_ADAPTER','DRY_RUN','NOT_ATTEMPTED'];
const statusEntries = statusOrder
  .map(st => ({label: DATA.status_meta[st] ? DATA.status_meta[st].label : st, c: rows.filter(r=>r.status===st).length}))
  .filter(e => e.c > 0);
// single blue hue, lightness steps down the ranked rows
bars('statusbars', statusEntries, e => `hsl(217 91% ${72 - 6*statusEntries.indexOf(e)}%)`);
const scoreEntries = [5,4,3,2,1,0].map(s => ({label:'Score '+s, c: rows.filter(r=>r.score===s).length})).filter(e=>e.c>0);
bars('scorebars', scoreEntries, e => `hsl(142 60% ${70 - 9*scoreEntries.indexOf(e)}%)`);

// ---------- table ----------
const COLS = [
  {k:'name',label:'Site'},{k:'category',label:'Category'},{k:'dr',label:'DR est.'},
  {k:'link_type',label:'Link type'},{k:'score',label:'Score'},{k:'status',label:'Status'},
  {k:'last_attempt',label:'Last attempt'},{k:'notes',label:'Notes'},
];
let sort = {k:'score', dir:-1};
const statusSel = document.getElementById('f-status');
Object.entries(DATA.status_meta).forEach(([k,m]) => {
  if (rows.some(r => r.status===k)) statusSel.insertAdjacentHTML('beforeend', `<option value="${k}">${esc(m.label)}</option>`);
});
const catSel = document.getElementById('f-cat');
[...new Set(rows.map(r=>r.category))].sort().forEach(c => catSel.insertAdjacentHTML('beforeend', `<option>${esc(c)}</option>`));

function renderHead(){
  document.getElementById('head').innerHTML = COLS.map(c =>
    `<th data-k="${c.k}">${c.label}${sort.k===c.k?`<span class="arrow">${sort.dir===1?'▲':'▼'}</span>`:''}</th>`).join('');
}
document.getElementById('head').addEventListener('click', e => {
  const th = e.target.closest('th'); if(!th) return;
  const k = th.dataset.k;
  sort = {k, dir: sort.k===k ? -sort.dir : (k==='score'?-1:1)};
  render();
});
function render(){
  renderHead();
  const q = document.getElementById('q').value.toLowerCase();
  const st = statusSel.value, sc = document.getElementById('f-score').value, cat = catSel.value;
  let out = rows.filter(r =>
    (!st || r.status===st) && (!sc || r.score===+sc) && (!cat || r.category===cat) &&
    (!q || (r.name+' '+r.notes+' '+r.category).toLowerCase().includes(q)));
  out.sort((a,b) => {
    const va=a[sort.k], vb=b[sort.k];
    if(typeof va==='number'&&typeof vb==='number') return (va-vb)*sort.dir;
    return String(va).localeCompare(String(vb))*sort.dir;
  });
  document.getElementById('body').innerHTML = out.map(r =>
    `<tr><td style="font-weight:600;white-space:nowrap">${esc(r.name)}</td>`+
    `<td style="color:var(--muted)">${esc(r.category.replace(/_/g,' '))}</td>`+
    `<td class="mono" style="color:var(--muted)">${esc(trunc(r.dr,16))}</td>`+
    `<td style="color:var(--muted)">${esc(trunc(r.link_type.split('(')[0],14))}</td>`+
    `<td style="text-align:center">${r.score}</td>`+
    `<td><span class="badge ${r.status_cls}">${esc(r.status_label)}</span></td>`+
    `<td class="mono" style="color:var(--muted)">${esc(r.last_attempt)}${r.retry_count?` <span style="color:var(--faint)">(${r.retry_count}x)</span>`:''}</td>`+
    `<td class="truncate" style="color:var(--faint);font-size:12px" title="${esc(r.notes)}">${esc(trunc(r.notes,140))}</td></tr>`).join('');
  document.getElementById('count').textContent = `${out.length} of ${rows.length} sites`;
}
['q','f-status','f-score','f-cat'].forEach(id => document.getElementById(id).addEventListener('input', render));
render();
</script>
</body>
</html>
"""


def render_html(
    rows: Sequence[Mapping[str, Any]],
    title: str = "Backlink Agent — Submission Report",
    generated: Optional[str] = None,
) -> str:
    """Render the full self-contained HTML document."""
    generated = generated or datetime.now(timezone.utc).date().isoformat()
    summary = summarize(rows)
    data = {
        "generated": generated,
        "summary": summary,
        "rows": list(rows),
        "status_meta": STATUS_META,
    }
    # Escape "</" so embedded JSON can never close the script element.
    data_json = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    html = _HTML_TEMPLATE.replace("__TITLE__", _escape_html(title))
    html = html.replace("__GENERATED__", generated)
    html = html.replace("__TOTAL__", str(summary["total"]))
    return html.replace("__DATA__", data_json)


def _escape_html(text: str) -> str:
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def write_report(
    sites: Sequence[Site],
    state: Any,
    out_path: str | Path,
    title: str = "Backlink Agent — Submission Report",
) -> Path:
    """Build rows, render HTML, write it to ``out_path``. Returns the path."""
    out = Path(out_path).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    html = render_html(build_rows(sites, state), title=title)
    out.write_text(html, encoding="utf-8")
    return out
