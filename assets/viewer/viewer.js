// The review viewer. Every piece of review data is rendered as text (textContent), never as HTML. A review is
// built once; the filters only show and hide what is there, so expanded context and the scroll position stay.
"use strict";

const SEVERITIES = ["critical", "important", "minor", "nit"];
const STATUSES = ["still-present", "partly-fixed", "unclear", "fixed"];
const STATUS_WORDS = { "still-present": "still present", "partly-fixed": "partly fixed", unclear: "unclear", fixed: "fixed" };
const CONTEXT = 3;
const NARROW = window.matchMedia("(max-width: 1100px)");

const state = {
  review: null,
  list: [],
  filters: null,
  // what build() made, for the filters: every comment card, the diff rows holding them, every file
  cards: [],
  rows: [],
  files: [],
  other: null,
  filesHeading: null,
  empty: null,
};

/** Per-browser conveniences; the page works the same when storage is blocked. */
const prefs = {
  get(key) {
    try {
      return localStorage.getItem(`pgh-${key}`);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`pgh-${key}`, value);
    } catch {
      // private window or blocked storage
    }
  },
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

const isVerify = (r) => r?.kind === "verify";
const when = (iso) => new Date(iso).toLocaleString();

function badge(cls, text) {
  return el("span", { class: `badge ${cls}`, text });
}

function countBy(comments, key, keys) {
  const c = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const x of comments) {
    const k = key(x);
    if (k in c) c[k]++;
  }
  return c;
}

function matches(c) {
  const f = state.filters;
  if (!f.severities.has(c.severity)) return false;
  if (isVerify(state.review) && !f.statuses.has(c.verdict?.status ?? "unclear")) return false;
  if (f.discipline !== "all" && c.discipline !== f.discipline) return false;
  if (f.query) {
    const hay = `${c.title} ${c.body} ${c.file} ${c.discipline} ${c.verdict?.evidence ?? ""}`.toLowerCase();
    if (!hay.includes(f.query.toLowerCase())) return false;
  }
  return true;
}

// ------------------------------------------------------------------------------------------ comments

function where(c) {
  if (c.line === null || c.line === undefined) return c.previous && c.previous.line !== null && c.previous.line !== undefined ? `was line ${c.previous.line}` : "file";
  const now = `${c.side === "old" ? "old " : ""}line ${c.line}${c.endLine && c.endLine !== c.line ? `-${c.endLine}` : ""}`;
  return c.previous && c.previous.line !== null && c.previous.line !== undefined && c.previous.line !== c.line ? `${now} (was ${c.previous.line})` : now;
}

function commentCard(c) {
  const v = c.verdict;
  const said = [c.body ? el("div", { class: "body", text: c.body }) : null, c.suggestion ? el("div", null, el("div", { class: "muted", text: "Suggestion" }), el("pre", { text: c.suggestion })) : null];
  const node = el(
    "div",
    { class: `comment sev-${c.severity}${v ? ` status-${v.status}` : ""}`, id: `comment-${c.id}` },
    el(
      "div",
      { class: "head" },
      v ? badge(`status status-${v.status}`, STATUS_WORDS[v.status] || v.status) : null,
      badge(`sev-${c.severity}`, c.severity),
      el("span", { class: "title", text: c.title || "(untitled)" }),
      el("span", { class: "tag", text: c.discipline }),
      el("span", { class: "muted", text: where(c) }),
      c.alreadyRaised ? el("span", { class: "tag", text: `raised before ×${c.alreadyRaised.occurrences}` }) : null,
    ),
    v?.evidence ? el("div", { class: "verdict" }, el("strong", { text: v.by === "check" ? "Check: " : v.by === "earlier" ? "Fixed in an earlier verification: " : "Verdict: " }), v.evidence) : null,
    // a verification leads with the verdict; what the review said folds away
    v ? (c.body || c.suggestion ? el("details", { class: "said" }, el("summary", { text: "What the review said" }), said) : null) : said,
    c.anchorAdjusted ? el("div", { class: "note", text: c.anchorAdjusted.reason }) : null,
  );
  state.cards.push({ comment: c, node });
  return node;
}

// ------------------------------------------------------------------------------------------ diffs

const lineKey = (side, n) => `${side}:${n}`;

function lineRows(l, commentsByLine, collapsed) {
  const cls = l.k === "+" ? "add" : l.k === "-" ? "del" : "ctx";
  const row = el("tr", { class: `${cls}${collapsed ? " collapsed" : ""}` }, el("td", { class: "num", text: l.o ?? "" }), el("td", { class: "num", text: l.n ?? "" }), el("td", { class: "mark", text: l.k === " " ? "" : l.k }), el("td", { class: "code", text: l.t }));
  const rows = [row];
  const attached = [...(l.n !== undefined ? commentsByLine.get(lineKey("new", l.n)) || [] : []), ...(l.o !== undefined && l.k === "-" ? commentsByLine.get(lineKey("old", l.o)) || [] : [])];
  if (attached.length) {
    const nodes = attached.map(commentCard);
    const r = el("tr", { class: `comment-row${collapsed ? " collapsed" : ""}` }, el("td", { colspan: "4" }, el("div", { class: "comment-stack" }, nodes)));
    state.rows.push({ row: r, nodes });
    rows.push(r);
  }
  return rows;
}

function renderHunk(hunk, commentsByLine, tbody) {
  tbody.append(el("tr", { class: "hunk" }, el("td", { colspan: "4", text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@ ${hunk.header || ""}` })));
  const lines = hunk.lines;
  // a verification is about the findings, so only the code around them is open; a review shows every change
  const focus = isVerify(state.review);
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    const anchored = (l.n !== undefined && commentsByLine.has(lineKey("new", l.n))) || (l.o !== undefined && commentsByLine.has(lineKey("old", l.o)));
    if (anchored || (!focus && l.k !== " ")) for (let j = Math.max(0, i - CONTEXT); j <= Math.min(lines.length - 1, i + CONTEXT); j++) keep[j] = true;
  });
  let i = 0;
  while (i < lines.length) {
    if (!keep[i]) {
      let j = i;
      while (j < lines.length && !keep[j]) j++;
      const hidden = [];
      for (let k = i; k < j; k++) hidden.push(...lineRows(lines[k], commentsByLine, true));
      const changed = lines.slice(i, j).some((l) => l.k !== " ");
      const gap = el("tr", { class: "gap" }, el("td", { colspan: "4" }, el("button", { type: "button", text: `⋯ show ${j - i} ${changed ? "" : "unchanged "}line(s)`, onclick: () => { gap.remove(); hidden.forEach((r) => r.classList.remove("collapsed")); } })));
      tbody.append(gap, ...hidden);
      i = j;
      continue;
    }
    tbody.append(...lineRows(lines[i], commentsByLine, false));
    i++;
  }
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
  const before = state.cards.length;
  const statusWord = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type changed" }[file.status] || file.status;
  const count = el("span", { class: "muted" });
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
      count,
    ),
  );
  let fileComments = null;
  if (fileLevel.length) {
    fileComments = el("div", { class: "file-comments" }, fileLevel.map(commentCard));
    section.append(fileComments);
  }
  if (file.summary) section.append(el("div", { class: "file-comments" }, el("div", { class: "muted", text: "Scene/resource change summary" }), el("pre", { text: file.summary })));
  const tbody = el("tbody");
  for (const h of file.hunks) renderHunk(h, byLine, tbody);
  const cols = el("colgroup", null, el("col", { class: "c-num" }), el("col", { class: "c-num" }), el("col", { class: "c-mark" }), el("col"));
  section.append(el("div", { class: "file-body" }, el("table", { class: "diff" }, cols, tbody)));
  return { section, count, fileComments, cards: state.cards.slice(before) };
}

// ------------------------------------------------------------------------------------------ page parts

function selectReview(id) {
  const select = document.getElementById("review-select");
  select.value = id;
  return load(id);
}

function reviewLink(id, text) {
  return el("a", { href: `?review=${encodeURIComponent(id)}`, text, onclick: (e) => { e.preventDefault(); void selectReview(id); } });
}

function renderMeta(r) {
  const meta = document.getElementById("meta");
  clear(meta);
  meta.append(el("span", { text: when(r.createdAt) }), r.model ? el("span", { class: "tag", text: r.model }) : null);
  if (isVerify(r)) {
    const c = countBy(r.comments, (x) => x.verdict?.status, STATUSES);
    meta.append(...STATUSES.map((s) => badge(`status status-${s}`, `${c[s]} ${STATUS_WORDS[s]}`)));
    if (r.verifies) meta.append(el("span", null, "checks ", reviewLink(r.verifies.id, `the review of ${when(r.verifies.createdAt)}`)));
  } else {
    const c = countBy(r.comments, (x) => x.severity, SEVERITIES);
    meta.append(...SEVERITIES.map((s) => badge(`sev-${s}`, `${c[s]} ${s}`)));
    const latest = state.list.find((x) => x.kind === "verify" && x.verifies === r.id);
    if (latest) meta.append(el("span", null, reviewLink(latest.id, `verified ${when(latest.createdAt)}`), `: ${latest.open} of ${latest.findings} open`));
  }
  meta.append(el("a", { href: `/api/review/${encodeURIComponent(r.id)}/md`, text: "review.md" }));
}

function checkbox(label, cls, checked, onchange) {
  return el("label", { class: cls }, el("input", { type: "checkbox", checked, onchange: (e) => onchange(e.target.checked) }), label);
}

function toggleIn(set, value) {
  return (on) => {
    if (on) set.add(value);
    else set.delete(value);
    applyFilters();
  };
}

function setWrap(on) {
  document.body.classList.toggle("wrap", on);
  prefs.set("wrap", on ? "1" : "0");
}

function renderFilters(r) {
  const box = document.getElementById("filters");
  clear(box);
  const f = state.filters;
  if (isVerify(r)) {
    const c = countBy(r.comments, (x) => x.verdict?.status, STATUSES);
    box.append(el("span", { class: "group" }, STATUSES.map((s) => checkbox(`${STATUS_WORDS[s]} (${c[s]})`, `status-${s}`, f.statuses.has(s), toggleIn(f.statuses, s)))));
  }
  box.append(el("span", { class: "group" }, SEVERITIES.map((s) => checkbox(s, `sev-${s}`, f.severities.has(s), toggleIn(f.severities, s)))));
  const disciplines = [...new Set(r.comments.map((c) => c.discipline))].sort();
  let timer;
  box.append(
    el("select", { "aria-label": "Discipline", onchange: (e) => { f.discipline = e.target.value; applyFilters(); } }, el("option", { value: "all", text: "all disciplines" }), disciplines.map((d) => el("option", { value: d, text: d }))),
    el("input", { type: "search", placeholder: "search findings", "aria-label": "Search findings", oninput: (e) => { clearTimeout(timer); timer = setTimeout(() => { f.query = e.target.value.trim(); applyFilters(); }, 150); } }),
    checkbox("only files with findings", "", f.onlyWithFindings, (on) => { f.onlyWithFindings = on; applyFilters(); }),
    checkbox("wrap long lines", "", document.body.classList.contains("wrap"), setWrap),
  );
}

function patchBlock(text) {
  const pre = el("pre", { class: "patch" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("@@") ? "p-hunk" : line.startsWith("+") && !line.startsWith("+++") ? "p-add" : line.startsWith("-") && !line.startsWith("---") ? "p-del" : "";
    pre.append(el("span", { class: cls, text: line || " " }));
  }
  return pre;
}

function overviewItem(c) {
  return el(
    "li",
    null,
    el("span", { class: "line" }, badge(`status status-${c.verdict.status}`, STATUS_WORDS[c.verdict.status]), badge(`sev-${c.severity}`, c.severity), el("a", { href: `#comment-${c.id}`, text: c.title || "(untitled)" }), el("span", { class: "muted", text: `${c.file || "project"}${c.line !== null && c.line !== undefined ? `:${c.line}` : ""}` })),
  );
}

function renderVerificationSummary(r, card) {
  const open = r.comments.filter((c) => c.verdict?.status !== "fixed");
  const fixed = r.comments.filter((c) => c.verdict?.status === "fixed");
  card.append(el("h2", { text: "Verification" }), el("p", { text: `The ${r.comments.length} finding(s) of the review of ${when(r.verifies?.createdAt ?? r.createdAt)}, checked against the code as it is now.` }));
  if (open.length) card.append(el("h2", { text: `Not fixed (${open.length})` }), el("ul", null, open.map(overviewItem)));
  else card.append(el("p", { class: "status-fixed", text: "Every finding was fixed." }));
  if (fixed.length) {
    card.append(
      el(
        "details",
        null,
        el("summary", { text: `Fixed (${fixed.length})` }),
        el("ul", null, fixed.map((c) => el("li", null, el("strong", { text: c.title || "(untitled)" }), el("span", { class: "muted", text: ` ${c.file || "project"}: ` }), c.verdict.evidence || ""))),
      ),
    );
  }
  const errors = (r.workers || []).filter((w) => w.error);
  if (errors.length) card.append(el("h2", { text: "Incomplete" }), el("ul", null, errors.map((w) => el("li", { class: "sev-critical", text: `${w.files.join(", ")}: ${w.error}` }))));
}

function renderSummary(r) {
  const box = document.getElementById("summary");
  clear(box);
  const card = el("div", { class: "summary-card" });
  if (r.status !== "complete") card.append(el("p", { class: "sev-critical", text: `Status: ${r.status}${r.error ? `: ${r.error}` : ""}` }));
  if (r.warnings?.length) card.append(el("h2", { text: isVerify(r) ? "Notes" : "Warnings" }), el("ul", null, r.warnings.map((w) => el("li", { text: w }))));
  if (isVerify(r)) {
    renderVerificationSummary(r, card);
    box.append(card);
    return;
  }
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

function table(head, rows) {
  return el("div", { class: "table-wrap" }, el("table", { class: "plain" }, el("tr", null, head.map((h) => el("th", { text: h }))), rows));
}

function renderExtra(r) {
  const box = document.getElementById("extra");
  clear(box);
  if (r.checks?.length) {
    const rows = r.checks.map((c) => el("tr", null, el("td", { text: c.name }), el("td", { text: c.status + (c.reason ? ` (${c.reason})` : "") }), el("td", { text: c.findings.length }), el("td", null, c.output ? el("details", null, el("summary", { text: "output" }), el("pre", { text: c.output })) : "")));
    box.append(el("h2", { text: "Checks" }), table(["check", "status", "findings", ""], rows));
    if (r.checksNote) box.append(el("p", { class: "muted", text: r.checksNote }));
  }
  const units = r.routing?.units || [];
  if (units.length) {
    box.append(
      el("h2", { text: "Routing" }),
      el("p", { class: "muted", text: `Routing: ${r.routing.classifier || "rules only"}${r.skills ? `. Skills: ${r.skills.tag ? `GodotPrompter ${r.skills.tag}` : r.skills.source}` : ""}` }),
      table(["part", "files", "skills", "other skills offered"], units.map((u) => el("tr", null, el("td", { text: u.id }), el("td", { text: u.files.join(", ") }), el("td", { text: u.skills.join(", ") }), el("td", { text: u.advertised.join(", ") })))),
    );
  }
  const skipped = (r.files || []).filter((f) => f.skipped);
  if (skipped.length) box.append(el("h2", { text: "Not reviewed" }), el("ul", null, skipped.map((f) => el("li", { text: `${f.path}: ${f.skipped}` }))));
}

function closeToc() {
  document.body.classList.remove("toc-open");
  document.getElementById("toc-toggle").setAttribute("aria-expanded", "false");
}

/** Build the page for state.review. */
function build() {
  const r = state.review;
  state.cards = [];
  state.rows = [];
  state.files = [];
  state.other = null;
  const heading = `${isVerify(r) ? "Verification" : "Review"}: ${r.target?.description || r.id}`;
  document.getElementById("title").textContent = heading;
  document.title = heading;
  renderMeta(r);
  renderFilters(r);
  renderSummary(r);

  const byFile = new Map();
  for (const x of r.comments) byFile.set(x.file, [...(byFile.get(x.file) || []), x]);
  const files = document.getElementById("files");
  const toc = document.getElementById("toc");
  clear(files);
  clear(toc);
  toc.append(el("div", { class: "toc-title", text: "Files" }));
  state.filesHeading = el("h2");
  state.empty = el("p", { class: "empty filtered", text: "No findings match the filters." });
  files.append(state.filesHeading, state.empty);
  const reviewed = (r.files || []).filter((f) => !f.skipped && f.hunks.length);
  for (const f of reviewed) {
    const built = renderFile(f, byFile.get(f.path) || []);
    files.append(built.section);
    const tocBadge = el("span", { class: "badge" });
    const link = el("a", { href: `#file-${encodeURIComponent(f.path)}`, onclick: () => { if (NARROW.matches) closeToc(); } }, el("span", { class: "path", text: f.path }), tocBadge);
    toc.append(link);
    state.files.push({ ...built, link, tocBadge });
  }
  const inDiff = new Set(reviewed.map((f) => f.path));
  const elsewhere = r.comments.filter((x) => !inDiff.has(x.file));
  if (elsewhere.length) {
    const before = state.cards.length;
    const section = el("div", null, el("h2", { text: "Other findings" }), el("div", null, elsewhere.map(commentCard)));
    files.append(section);
    state.other = { section, cards: state.cards.slice(before) };
  }
  renderExtra(r);
  applyFilters();
}

/** Show and hide comments, rows and files for the current filters. */
function applyFilters() {
  const shown = (card) => !card.node.classList.contains("filtered");
  for (const card of state.cards) card.node.classList.toggle("filtered", !matches(card.comment));
  for (const row of state.rows) row.row.classList.toggle("filtered", row.nodes.every((n) => n.classList.contains("filtered")));
  let listed = 0;
  for (const f of state.files) {
    const n = f.cards.filter(shown).length;
    f.count.textContent = !f.cards.length ? "" : n === f.cards.length ? `${n} finding(s)` : `${n} of ${f.cards.length} finding(s) shown`;
    f.tocBadge.textContent = String(n);
    f.tocBadge.classList.toggle("filtered", n === 0);
    if (f.fileComments) f.fileComments.classList.toggle("filtered", ![...f.fileComments.querySelectorAll(".comment")].some((c) => !c.classList.contains("filtered")));
    const hide = state.filters.onlyWithFindings && n === 0;
    f.section.classList.toggle("filtered", hide);
    f.link.classList.toggle("filtered", hide);
    if (!hide) listed++;
  }
  if (state.other) state.other.section.classList.toggle("filtered", !state.other.cards.some(shown));
  state.filesHeading.textContent = `Files (${listed}${listed !== state.files.length ? ` of ${state.files.length}` : ""})`;
  state.empty.classList.toggle("filtered", !state.cards.length || state.cards.some(shown));
}

function show(review) {
  state.review = review;
  state.filters = {
    severities: new Set(SEVERITIES),
    // a verification opens on what is left to do
    statuses: new Set(isVerify(review) ? STATUSES.filter((s) => s !== "fixed") : STATUSES),
    discipline: "all",
    query: "",
    onlyWithFindings: isVerify(review),
  };
  const url = new URL(location.href);
  url.searchParams.set("review", review.id);
  url.searchParams.delete("t");
  history.replaceState(null, "", url);
  build();
  window.scrollTo(0, 0);
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

/** Keep the sticky offsets in step with the header (it wraps on narrow screens) and the content width. */
function trackLayout() {
  const root = document.documentElement.style;
  const header = document.getElementById("top");
  const content = document.getElementById("content");
  const update = () => {
    root.setProperty("--header-h", getComputedStyle(header).position === "sticky" ? `${header.offsetHeight}px` : "0px");
    root.setProperty("--content-w", `${content.clientWidth}px`);
  };
  if ("ResizeObserver" in window) {
    const ro = new ResizeObserver(update);
    ro.observe(header);
    ro.observe(content);
  }
  window.addEventListener("resize", update);
  update();
}

function setupToc() {
  const toggle = document.getElementById("toc-toggle");
  toggle.addEventListener("click", () => {
    const open = document.body.classList.toggle("toc-open");
    toggle.setAttribute("aria-expanded", String(open));
  });
  document.getElementById("scrim").addEventListener("click", closeToc);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeToc();
  });
  NARROW.addEventListener("change", (e) => {
    if (!e.matches) closeToc();
  });
}

function listLabel(r) {
  return r.kind === "verify" ? `${when(r.createdAt)} · Verification: ${r.description} (${r.open} of ${r.findings} open)` : `${when(r.createdAt)} · ${r.description} (${r.findings})`;
}

async function main() {
  const wrap = prefs.get("wrap");
  document.body.classList.toggle("wrap", wrap === null ? window.innerWidth < 1400 : wrap === "1");
  trackLayout();
  setupToc();
  try {
    state.list = embedded("review-list") || (await getJson("/api/reviews"));
    const select = document.getElementById("review-select");
    clear(select);
    for (const r of state.list) select.append(el("option", { value: r.id, text: listLabel(r) }));
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
