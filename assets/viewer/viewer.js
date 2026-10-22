// The review viewer. Every piece of review data is rendered as text (textContent), never as HTML.
"use strict";

const SEVERITIES = ["critical", "important", "minor", "nit"];
const CONTEXT = 3;

const state = {
  review: null,
  list: [],
  filters: { severities: new Set(SEVERITIES), discipline: "all", query: "", onlyWithFindings: false },
};

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = String(v);
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else if (k === "dataset") Object.assign(node.dataset, v);
      else node.setAttribute(k, v === true ? "" : String(v));
    }
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

async function getJson(path) {
  const res = await fetch(path, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

function severityBadge(sev, count) {
  return el("span", { class: `badge sev-${sev}`, text: count === undefined ? sev : `${count} ${sev}` });
}

function counts(comments) {
  const c = { critical: 0, important: 0, minor: 0, nit: 0 };
  for (const x of comments) c[x.severity] = (c[x.severity] || 0) + 1;
  return c;
}

function visible(comment) {
  const f = state.filters;
  if (!f.severities.has(comment.severity)) return false;
  if (f.discipline !== "all" && comment.discipline !== f.discipline) return false;
  if (f.query) {
    const hay = `${comment.title} ${comment.body} ${comment.file} ${comment.discipline}`.toLowerCase();
    if (!hay.includes(f.query.toLowerCase())) return false;
  }
  return true;
}

function commentCard(c) {
  const where = c.line === null || c.line === undefined ? "file" : `${c.side === "old" ? "old " : ""}line ${c.line}${c.endLine && c.endLine !== c.line ? `-${c.endLine}` : ""}`;
  return el(
    "div",
    { class: `comment sev-${c.severity}`, id: `comment-${c.id}`, dataset: { severity: c.severity, discipline: c.discipline } },
    el("div", { class: "head" }, severityBadge(c.severity), el("span", { class: "title", text: c.title || "(untitled)" }), el("span", { class: "tag", text: c.discipline }), el("span", { class: "muted", text: where }), c.alreadyRaised ? el("span", { class: "tag", text: `raised before ×${c.alreadyRaised.occurrences}` }) : null),
    c.body ? el("div", { class: "body", text: c.body }) : null,
    c.suggestion ? el("div", null, el("div", { class: "muted", text: "Suggestion" }), el("pre", { text: c.suggestion })) : null,
    c.anchorAdjusted ? el("div", { class: "note", text: c.anchorAdjusted.reason }) : null,
  );
}

function commentRow(comments) {
  return el("tr", { class: "comment-row" }, el("td", { colspan: "4" }, comments.map(commentCard)));
}

function lineKey(side, n) {
  return `${side}:${n}`;
}

function renderHunk(hunk, commentsByLine, tbody) {
  tbody.append(el("tr", { class: "hunk" }, el("td", { colspan: "4", text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@ ${hunk.header || ""}` })));
  const lines = hunk.lines;
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    const anchored = (l.n !== undefined && commentsByLine.has(lineKey("new", l.n))) || (l.o !== undefined && commentsByLine.has(lineKey("old", l.o)));
    if (l.k !== " " || anchored) for (let j = Math.max(0, i - CONTEXT); j <= Math.min(lines.length - 1, i + CONTEXT); j++) keep[j] = true;
  });
  let i = 0;
  while (i < lines.length) {
    if (!keep[i]) {
      let j = i;
      while (j < lines.length && !keep[j]) j++;
      const hiddenRows = [];
      for (let k = i; k < j; k++) hiddenRows.push(...lineRows(lines[k], commentsByLine, true));
      const gap = el("tr", { class: "gap" }, el("td", { colspan: "4" }, el("button", { type: "button", text: `⋯ show ${j - i} unchanged line(s)`, onclick: () => { gap.remove(); hiddenRows.forEach((r) => r.classList.remove("hidden")); } })));
      tbody.append(gap, ...hiddenRows);
      i = j;
      continue;
    }
    tbody.append(...lineRows(lines[i], commentsByLine, false));
    i++;
  }
}

function lineRows(l, commentsByLine, hidden) {
  const cls = l.k === "+" ? "add" : l.k === "-" ? "del" : "ctx";
  const row = el("tr", { class: `${cls}${hidden ? " hidden" : ""}` }, el("td", { class: "num", text: l.o ?? "" }), el("td", { class: "num", text: l.n ?? "" }), el("td", { class: "num", text: l.k === " " ? "" : l.k }), el("td", { text: l.t }));
  const rows = [row];
  const attached = [...(l.n !== undefined ? commentsByLine.get(lineKey("new", l.n)) || [] : []), ...(l.o !== undefined && l.k === "-" ? commentsByLine.get(lineKey("old", l.o)) || [] : [])];
  if (attached.length) {
    const r = commentRow(attached);
    if (hidden) r.classList.add("hidden");
    rows.push(r);
  }
  return rows;
}

function unitFor(path) {
  return (state.review.routing?.units || []).find((u) => u.files.includes(path));
}

function renderFile(file, comments) {
  const unit = unitFor(file.path);
  const fileLevel = comments.filter((c) => c.line === null || c.line === undefined);
  const byLine = new Map();
  for (const c of comments) {
    if (c.line === null || c.line === undefined) continue;
    const key = lineKey(c.side || "new", c.line);
    byLine.set(key, [...(byLine.get(key) || []), c]);
  }
  const statusWord = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type changed" }[file.status] || file.status;
  const section = el(
    "div",
    { class: "file", id: `file-${encodeURIComponent(file.path)}` },
    el(
      "div",
      { class: "file-head" },
      el("span", { class: "path", text: file.path }),
      el("span", { class: "tag", text: statusWord }),
      file.oldPath ? el("span", { class: "muted", text: `from ${file.oldPath}` }) : null,
      el("span", { class: "stat-add", text: `+${file.added}` }),
      el("span", { class: "stat-del", text: `-${file.removed}` }),
      unit ? el("span", { class: "muted", text: `skills: ${unit.skills.join(", ") || "none"}` }) : null,
      comments.length ? el("span", { class: "muted", text: `${comments.length} comment(s)` }) : null,
    ),
  );
  if (fileLevel.length) section.append(el("div", { class: "file-comments" }, fileLevel.map(commentCard)));
  if (file.summary) section.append(el("div", { class: "file-comments" }, el("div", { class: "muted", text: "Scene/resource change summary" }), el("pre", { text: file.summary })));
  const tbody = el("tbody");
  for (const h of file.hunks) renderHunk(h, byLine, tbody);
  section.append(el("div", { class: "file-body" }, el("table", { class: "diff" }, tbody)));
  return section;
}

function patchBlock(text) {
  const pre = el("pre", { class: "patch" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("@@") ? "p-hunk" : line.startsWith("+") && !line.startsWith("+++") ? "p-add" : line.startsWith("-") && !line.startsWith("---") ? "p-del" : "";
    pre.append(el("span", { class: cls, text: line || " " }));
  }
  return pre;
}

function renderSummary(r) {
  const box = document.getElementById("summary");
  clear(box);
  const card = el("div", { class: "summary-card" });
  if (r.status !== "complete") card.append(el("p", { class: "sev-critical", text: `Status: ${r.status}${r.error ? `: ${r.error}` : ""}` }));
  if (r.warnings?.length) card.append(el("h2", { text: "Warnings" }), el("ul", null, r.warnings.map((w) => el("li", { text: w }))));
  const sums = (r.workers || []).filter((w) => w.summary || w.error);
  if (sums.length) card.append(el("h2", { text: "Summary" }), el("ul", null, sums.map((w) => el("li", null, el("strong", { text: w.files.join(", ") }), ` (${w.skills.join(", ") || "no skills"}): ${w.summary || ""}`, w.error ? el("span", { class: "sev-critical", text: ` worker error: ${w.error}` }) : null))));
  const doc = r.docPass;
  card.append(el("h2", { text: "Documentation" }));
  if (!doc) card.append(el("p", { class: "muted", text: "The doc pass did not run." }));
  else if (doc.skipped) card.append(el("p", { class: "muted", text: `Skipped: ${doc.skipped}` }));
  else {
    if (doc.error) card.append(el("p", { class: "sev-critical", text: doc.error }));
    if (!doc.patches?.length) card.append(el("p", { class: "muted", text: "DESIGN.md and AGENTS.md were left unchanged." }));
    for (const p of doc.patches || []) card.append(el("div", { class: "muted", text: `Changed ${p.file}` }), patchBlock(p.patch));
    if (doc.finalText) card.append(el("p", { text: doc.finalText }));
  }
  box.append(card);
}

function renderExtra(r) {
  const box = document.getElementById("extra");
  clear(box);
  if (r.checks?.length) {
    const rows = r.checks.map((c) => el("tr", null, el("td", { text: c.name }), el("td", { text: c.status + (c.reason ? ` (${c.reason})` : "") }), el("td", { text: c.findings.length }), el("td", null, c.output ? el("details", null, el("summary", { text: "output" }), el("pre", { text: c.output })) : "")));
    box.append(el("h2", { text: "Checks" }), el("table", { class: "plain" }, el("tr", null, el("th", { text: "check" }), el("th", { text: "status" }), el("th", { text: "findings" }), el("th", { text: "" })), rows));
    if (r.checksNote) box.append(el("p", { class: "muted", text: r.checksNote }));
  }
  const units = r.routing?.units || [];
  if (units.length) {
    box.append(
      el("h2", { text: "Routing" }),
      el("p", { class: "muted", text: `Routing: ${r.routing.classifier || "rules only"}${r.skills ? `. Skills: ${r.skills.tag ? `GodotPrompter ${r.skills.tag}` : r.skills.source}` : ""}` }),
      el("table", { class: "plain" }, el("tr", null, el("th", { text: "part" }), el("th", { text: "files" }), el("th", { text: "skills" }), el("th", { text: "other skills offered" })), units.map((u) => el("tr", null, el("td", { text: u.id }), el("td", { text: u.files.join(", ") }), el("td", { text: u.skills.join(", ") }), el("td", { text: u.advertised.join(", ") })))),
    );
  }
  const skipped = (r.files || []).filter((f) => f.skipped);
  if (skipped.length) box.append(el("h2", { text: "Not reviewed" }), el("ul", null, skipped.map((f) => el("li", { text: `${f.path}: ${f.skipped}` }))));
}

function render() {
  const r = state.review;
  if (!r) return;
  document.getElementById("title").textContent = `Review: ${r.target?.description || r.id}`;
  document.title = `Review: ${r.target?.description || r.id}`;
  const meta = document.getElementById("meta");
  clear(meta);
  const c = counts(r.comments);
  meta.append(el("span", { text: new Date(r.createdAt).toLocaleString() }), r.model ? el("span", { class: "tag", text: r.model }) : null, ...SEVERITIES.map((s) => severityBadge(s, c[s])), el("a", { href: `/api/review/${encodeURIComponent(r.id)}/md`, text: "review.md" }));

  const shown = r.comments.filter(visible);
  const byFile = new Map();
  for (const x of shown) byFile.set(x.file, [...(byFile.get(x.file) || []), x]);
  const files = document.getElementById("files");
  const toc = document.getElementById("toc");
  clear(files);
  clear(toc);
  const reviewed = (r.files || []).filter((f) => !f.skipped && f.hunks.length);
  const listed = state.filters.onlyWithFindings ? reviewed.filter((f) => byFile.has(f.path)) : reviewed;
  files.append(el("h2", { text: `Files (${listed.length})` }));
  for (const f of listed) {
    files.append(renderFile(f, byFile.get(f.path) || []));
    const n = (byFile.get(f.path) || []).length;
    toc.append(el("a", { href: `#file-${encodeURIComponent(f.path)}` }, el("span", { text: f.path }), n ? el("span", { class: "badge", text: n }) : null));
  }
  const inDiff = new Set(reviewed.map((f) => f.path));
  const elsewhere = shown.filter((x) => !inDiff.has(x.file));
  if (elsewhere.length) files.append(el("h2", { text: "Other findings" }), el("div", null, elsewhere.map(commentCard)));
  renderSummary(r);
  renderExtra(r);
}

function renderFilters() {
  const box = document.getElementById("filters");
  clear(box);
  for (const s of SEVERITIES) {
    box.append(el("label", { class: `sev-${s}` }, el("input", { type: "checkbox", checked: state.filters.severities.has(s), onchange: (e) => { if (e.target.checked) state.filters.severities.add(s); else state.filters.severities.delete(s); render(); } }), s));
  }
  const disciplines = [...new Set((state.review?.comments || []).map((c) => c.discipline))].sort();
  const sel = el("select", { "aria-label": "Discipline", onchange: (e) => { state.filters.discipline = e.target.value; render(); } }, el("option", { value: "all", text: "all disciplines" }), disciplines.map((d) => el("option", { value: d, text: d, selected: state.filters.discipline === d })));
  box.append(
    sel,
    el("input", { type: "search", placeholder: "search findings", value: state.filters.query, oninput: (e) => { state.filters.query = e.target.value; render(); } }),
    el("label", null, el("input", { type: "checkbox", checked: state.filters.onlyWithFindings, onchange: (e) => { state.filters.onlyWithFindings = e.target.checked; render(); } }), "only files with findings"),
  );
}

function show(review) {
  state.review = review;
  const url = new URL(location.href);
  url.searchParams.set("review", review.id);
  url.searchParams.delete("t");
  history.replaceState(null, "", url);
  renderFilters();
  render();
}

async function load(id) {
  show(await getJson(`/api/review/${encodeURIComponent(id)}`));
}

/** The server embeds the requested review and the list as JSON data blocks; parse them as data. */
function embedded(id) {
  const node = document.getElementById(id);
  if (!node) return null;
  try {
    return JSON.parse(node.textContent || "null");
  } catch {
    return null;
  }
}

async function main() {
  try {
    state.list = embedded("review-list") || (await getJson("/api/reviews"));
    const select = document.getElementById("review-select");
    clear(select);
    for (const r of state.list) select.append(el("option", { value: r.id, text: `${new Date(r.createdAt).toLocaleString()} · ${r.description} (${r.findings})` }));
    select.addEventListener("change", () => load(select.value));
    const initial = embedded("review-data");
    const wanted = initial?.id || new URL(location.href).searchParams.get("review") || state.list[0]?.id;
    if (!wanted) {
      document.getElementById("title").textContent = "No reviews yet";
      return;
    }
    select.value = wanted;
    if (initial && initial.id === wanted) show(initial);
    else await load(wanted);
  } catch (error) {
    document.getElementById("title").textContent = `Could not load the review: ${error.message}`;
  }
}

document.addEventListener("DOMContentLoaded", main);
