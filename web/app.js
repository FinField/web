/* FinField explorer — no framework, no build step. Data: ./data/ shards. */
"use strict";

const DATA = "data";

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const safeTicker = (t) => t.replace(/ /g, "_").replace(/\//g, "-");
const shardPath = (t) => {
  const n = safeTicker(t);
  return `${DATA}/companies/${n.slice(0, 2).toUpperCase()}/${encodeURIComponent(n)}.json`;
};
const companyHref = (t) => `company.html?t=${encodeURIComponent(t)}`;

/* value = fact.value * 10^-scale, rendered exactly from the integer */
function renderValue(value, scale) {
  let s = String(Math.abs(value)).padStart(scale + 1, "0");
  const sign = value < 0 ? "-" : "";
  let int = scale ? s.slice(0, -scale) : s;
  const frac = scale ? s.slice(-scale).replace(/0+$/, "") : "";
  int = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return sign + int + (frac ? "." + frac : "");
}

function provLine(fact) {
  const src = fact.source || {};
  let ref = esc(src.ref || "");
  if (src.kind === "sec-companyfacts" && /^\d{10}-\d{2}-\d{6}$/.test(src.ref)) {
    const url = `https://www.sec.gov/Archives/edgar/data/${parseInt(src.ref.slice(0, 10), 10)}/${src.ref.replace(/-/g, "")}`;
    ref = `<a href="${url}" rel="noopener">${esc(src.ref)}</a>`;
  }
  const inputs = (fact.derived_from || [])
    .map((c) => `<a class="cid" href="#f-${esc(c.slice(-12))}" title="${esc(c)}">&larr;${esc(c.slice(-8))}</a>`)
    .join(" ");
  return (
    `<div class="prov">${esc(src.kind || "?")}` +
    (ref ? ` &middot; ${ref}` : "") +
    (src.fetched ? ` &middot; fetched ${esc(src.fetched)}` : "") +
    ` &middot; <span class="cid" title="${esc(fact.cid)}">cid &hellip;${esc(fact.cid.slice(-12))}</span>` +
    (inputs ? ` &middot; from ${inputs}` : "") +
    `</div>`
  );
}

function factBlock(fact) {
  const p = fact.period || {};
  const period = p.start ? `${esc(p.start)} &rarr; ${esc(p.end)}` : esc(p.end || "");
  return (
    `<div class="fact" id="f-${esc(fact.cid.slice(-12))}"><div class="row">` +
    `<span class="concept">${esc(fact.concept)}</span>` +
    `<span class="badge">${period}</span>` +
    `<span class="val">${renderValue(fact.value, fact.scale)} ${esc(fact.unit)}</span>` +
    `</div>${provLine(fact)}</div>`
  );
}

/* ---------------- index page ---------------- */
async function initSearch() {
  const box = $("#q"), list = $("#results"), stats = $("#stats");
  const [idx, meta] = await Promise.all([
    fetch(`${DATA}/index/search.json`).then((r) => r.json()),
    fetch(`${DATA}/meta.json`).then((r) => r.json()).catch(() => null),
  ]);
  const rows = idx.rows;
  if (meta) stats.textContent = `${meta.companies.toLocaleString()} listed companies · ${meta.with_facts} with facts · every number carries its source + CID`;

  function run() {
    const q = box.value.trim().toUpperCase();
    list.innerHTML = "";
    if (q.length < 1) return;
    const hits = [];
    for (const row of rows) {
      const [t, n] = row;
      if (t.toUpperCase().includes(q) || (n && n.toUpperCase().includes(q))) {
        hits.push(row);
        if (hits.length >= 50) break;
      }
    }
    list.innerHTML = hits
      .map(
        ([t, n, c, a, asset]) =>
          `<li><a href="${companyHref(t)}"><span class="t">${esc(t)}</span>` +
          `<span class="n">${esc(n || "")}</span>` +
          `<span class="c">${esc(c)}${asset && asset !== "equity" ? " · " + esc(asset) : ""}${a ? "" : " · inactive"}</span></a></li>`
      )
      .join("");
  }
  box.addEventListener("input", run);
  box.focus();
}

/* ---------------- company page ---------------- */
async function initCompany() {
  const ticker = new URLSearchParams(location.search).get("t");
  const el = $("#company");
  if (!ticker) { el.innerHTML = '<p class="empty">No ticker given.</p>'; return; }
  document.title = `${ticker} — FinField`;
  let doc;
  try {
    const r = await fetch(shardPath(ticker));
    if (!r.ok) throw new Error(r.status);
    doc = await r.json();
  } catch {
    el.innerHTML = `<p class="empty">Unknown company: ${esc(ticker)}</p>`;
    return;
  }
  const e = doc.entity;
  let html = `<h1>${esc(e.name || e.ticker)}</h1><div class="idcard"><dl>`;
  for (const [k, label] of [["ticker", "ticker"], ["country", "country"], ["asset", "asset"], ["cik", "CIK"], ["lei", "LEI"], ["figi", "FIGI"]])
    if (e[k]) html += `<dt>${label}</dt><dd>${esc(e[k])}</dd>`;
  html += `</dl></div>`;

  if (doc.derived.length) html += `<h2>Smart metrics (derived, provenance-linked)</h2>` + doc.derived.map(factBlock).join("");
  if (doc.facts.length) html += `<h2>Annual facts (audited filings)</h2>` + doc.facts.map(factBlock).join("");
  if (!doc.facts.length && !doc.derived.length)
    html += `<p class="empty">No fact coverage for this listing yet — identity only. US listings gain SEC facts first; other jurisdictions follow via ESEF/GLEIF.</p>`;
  el.innerHTML = html;
}

if ($("#q")) initSearch();
if ($("#company")) initCompany();
