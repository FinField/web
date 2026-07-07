// FinField Studio — cross-field knit + signed-verdict voting.
// Engine bootstrap + UI wiring (main-thread ES module).
//
// ARCHITECTURE (mirrors the proven MOLGANG serverless pattern):
//   • The REAL peer is the UNCHANGED finfacts + finknit + knitweb Python bytes,
//     run inside a Web Worker via Pyodide/WASM (emitted inline below as a Blob
//     so this module stays the single shell file).
//   • This main-thread module is a THIN shell: it derives the device seed, boots
//     the worker, talks to the engine over a postMessage RPC, and wires the
//     Studio UI. JS NEVER computes a CID, a canonical-CBOR frame, or a
//     signature — those sacred-invariant paths live ONLY in the WASM engine.
//
// The Studio is a cross-field knitweb surface: pick a field (finfield, chemfield,
// intelfield, ledgerfield), knit a new term (or, for finfield, propose an
// integer-only fact), and cast a signed verdict on any woven CID.
//
// Vocabulary: this is the Knitweb — we weave Fibers, Knit terms, sign with a
// Pulse account, and pay in PLS. (Never "loom".)

const BOOT = {
  bar: document.getElementById("boot-bar"),
  phase: document.getElementById("boot-phase"),
  err: document.getElementById("boot-err"),
  splash: document.getElementById("boot"),
};

let bootFailed = false;
function bootProgress(pct, phase) {
  if (bootFailed) return; // an error phase is STICKY: later progress must not overwrite it
  if (BOOT.bar) BOOT.bar.style.width = Math.max(4, Math.min(100, pct)) + "%";
  if (phase && BOOT.phase) BOOT.phase.textContent = phase;
}
function bootError(message) {
  bootFailed = true;
  if (BOOT.err) BOOT.err.textContent = message;
  if (BOOT.phase) BOOT.phase.textContent = "boot failed";
  if (BOOT.bar) BOOT.bar.classList.add("failed");
}
function bootDone() {
  if (BOOT.splash) BOOT.splash.classList.add("done");
  document.getElementById("studio")?.classList.remove("hidden");
}

// Pinned Pyodide build (same pin as the molgang serverless engine). The
// secp256k1 backend (cryptography/OpenSSL in-WASM) must emit DER/low-S bytes
// byte-identical to native CPython; bump only behind a green conformance run.
const PYODIDE_VERSION = "0.26.2";
const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

// ABSOLUTE URLs, computed on the MAIN thread. The engine worker runs from a
// blob: URL, and a blob URL CANNOT base relative fetches — micropip.install of
// "./engine/….whl" inside the worker throws "Failed to parse URL" and the
// engine never boots (molgang's #1 boot bug). Resolving against location.href
// here keeps the app path-relative: it works at / or under any subpath
// (/studio/, /web/studio/, …) on a dumb static file host.
const ENGINE_WHEEL_URL = new URL(
  "engine/finfield_engine-0.0.0-py3-none-any.whl", location.href).href;
const BRIDGE_PY_URL = new URL("engine/fin_serverless.py", location.href).href;

// ---------------------------------------------------------------------------
// Device seed (the ONLY secret JS handles; it never leaves this origin). The
// engine stretches it (pbkdf2) into the wallet private key. Entropy is
// WebCrypto getRandomValues (CSPRNG), never Math.random.
// ---------------------------------------------------------------------------
function deviceSeed() {
  let d = localStorage.getItem("finfield_studio_device");
  if (!d) {
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    d = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
    localStorage.setItem("finfield_studio_device", d);
  }
  return d;
}

// ---------------------------------------------------------------------------
// Engine RPC client (main thread <-> Pyodide worker).
// ---------------------------------------------------------------------------
class Engine {
  constructor(worker) {
    this.worker = worker;
    this.seq = 1;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => { this._res = res; this._rej = rej; });
    worker.addEventListener("message", (ev) => this._onMessage(ev.data));
  }

  _onMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.kind === "reply") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
      return;
    }
    if (msg.kind === "boot") { bootProgress(msg.pct, msg.phase); return; }
    if (msg.kind === "ready") { this._res && this._res(); return; }
    if (msg.kind === "boot-error") {
      // Fatal engine-boot failure: surface it immediately (sticky) and reject
      // the boot waiter NOW instead of sitting out the watchdog.
      bootError(msg.message);
      this._rej && this._rej(new Error(msg.message));
      return;
    }
  }

  call(method, args = {}) {
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ kind: "rpc", id, method, args });
    });
  }

  account() { return this.call("account"); }
  propose(fact) { return this.call("propose", { fact }); }
  knit(term) { return this.call("knit", { term }); }
  verdict(cid, correct) { return this.call("verdict", { cid, correct }); }
  tally(cid) { return this.call("tally", { cid }); }
  seedFacts(facts) { return this.call("seed_facts", { facts }); }
  seedTerms(terms) { return this.call("seed_terms", { terms }); }
  export() { return this.call("export"); }
}

// ---------------------------------------------------------------------------
// Build the engine worker. A tiny module-free bootstrap is emitted inline as a
// Blob; its only job is to load Pyodide, install the UNCHANGED finfacts +
// finknit + knitweb wheel, run the bridge, and answer RPC.
// ---------------------------------------------------------------------------
function spawnEngineWorker() {
  const seed = deviceSeed();
  const bootstrap = `
    const PYODIDE_BASE = ${JSON.stringify(PYODIDE_BASE)};
    const SEED = ${JSON.stringify(seed)};
    const ENGINE_WHEEL_URL = ${JSON.stringify(ENGINE_WHEEL_URL)};
    const BRIDGE_PY_URL = ${JSON.stringify(BRIDGE_PY_URL)};

    function post(m) { self.postMessage(m); }
    function boot(pct, phase) { post({ kind: "boot", pct, phase }); }

    let pyodide = null;
    let engine = null; // the Python bridge object (PyProxy)

    async function init() {
      boot(8, "fetching WASM runtime…");
      importScripts(PYODIDE_BASE + "pyodide.js");
      boot(28, "starting Python…");
      pyodide = await self.loadPyodide({ indexURL: PYODIDE_BASE });
      boot(46, "loading crypto backend…");
      // 'cryptography' = secp256k1/SHA-256 (OpenSSL in-WASM) that knitweb.core.crypto
      // hard-imports; 'hashlib' = Pyodide's OpenSSL stdlib piece needed for
      // pbkdf2_hmac (the device→wallet KDF). A failure here is FATAL (fail fast).
      await pyodide.loadPackage(["micropip", "hashlib"]);
      const micropip = pyodide.pyimport("micropip");
      await micropip.install(["cryptography"]);
      boot(64, "mounting engine bytes…");
      // finfacts + finknit + knitweb as ONE wheel — the IDENTICAL .py bytes that
      // make every node's CIDv1 agree. Fatal on failure (everything imports them).
      await micropip.install(ENGINE_WHEEL_URL);
      boot(80, "wiring the in-tab knitweb…");
      const bridgeResp = await fetch(BRIDGE_PY_URL);
      if (!bridgeResp.ok) throw new Error("bridge fetch failed: HTTP " + bridgeResp.status);
      pyodide.runPython(await bridgeResp.text());
      boot(92, "deriving your pulse account…");
      const make = pyodide.globals.get("make_bridge");
      engine = make(SEED);
      make.destroy();
      boot(100, "ready");
      post({ kind: "ready" });
    }

    self.onmessage = async (ev) => {
      const msg = ev.data || {};
      const reply = (result, error) => post({ kind: "reply", id: msg.id, result, error });
      try {
        if (msg.kind !== "rpc") return;
        if (!engine) { reply(null, "engine not ready"); return; }
        // The bridge returns json.dumps({ok, result|error}); parse and unwrap.
        const outStr = engine.dispatch(msg.method, msg.args ? JSON.stringify(msg.args) : "");
        const out = JSON.parse(outStr);
        if (out.ok) reply(out.result);
        else reply(null, out.error || "engine error");
      } catch (err) {
        reply(null, (err && err.message) || String(err));
      }
    };

    init().catch((err) => post({ kind: "boot-error", message: (err && err.message) || String(err) }));
  `;
  const blob = new Blob([bootstrap], { type: "text/javascript" });
  return new Worker(URL.createObjectURL(blob));
}

// ---------------------------------------------------------------------------
// UI helpers.
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function toast(msg, kind = "") {
  const t = $("toast");
  if (!t) return;
  t.textContent = msg;
  t.className = "toast show " + kind;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = "toast"; }, 4200);
}
function shortCid(cid, n = 18) {
  const s = String(cid || "");
  return s.length > n + 6 ? s.slice(0, n) + "…" + s.slice(-4) : s;
}

let currentField = "finfield";

// ---------------------------------------------------------------------------
// Seed data: a couple of real finfield facts (root-relative from the explorer
// data pack, with a hardcoded fallback) + a few example terms per field.
// ---------------------------------------------------------------------------
const SEED_CONCEPTS = [
  "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax",
  "us-gaap:Assets",
  "us-gaap:NetIncomeLoss",
];

function factsFromDoc(doc, take) {
  const ent = doc.entity || {};
  const out = [];
  const concepts = doc.concepts || {};
  for (const concept of (take || SEED_CONCEPTS)) {
    const arr = concepts[concept];
    if (Array.isArray(arr) && arr.length) {
      const f = arr[0];
      out.push({
        entity: ent.ticker, name: ent.name || "", asset: ent.asset || "equity",
        concept: f.concept, value: f.value, scale: f.scale || 0, unit: f.unit,
        period: f.period || {}, source: f.source || {},
      });
    }
  }
  return out;
}

const FALLBACK_FACTS = [
  { entity: "AAPL US", name: "Apple Inc.", asset: "equity",
    concept: "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax",
    value: 391035000000, scale: 0, unit: "USD",
    period: { end: "2024-09-28", start: "2023-10-01", fy: 2024, fp: "FY" },
    source: { kind: "sec-companyfacts", ref: "0000320193-24-000123", fetched: "2026-07-06" } },
  { entity: "BTC CRYPTO", name: "", asset: "crypto",
    concept: "finfield:block_height", value: 957009, scale: 0, unit: "blocks",
    period: { end: "2026-07-07" },
    source: { kind: "onchain", ref: "mempool.space/api/v1/blocks@957009", fetched: "2026-07-07" } },
];

const SEED_TERMS = [
  { field: "chemfield", term: "NH BLOOM",
    definition: "biostimulant derived from steel slag (Slag B.V.)",
    relations: [{ rel: "derived-from", target: "steel-slag" }] },
  { field: "chemfield", term: "VRFB electrolyte",
    definition: "vanadium redox-flow-battery electrolyte leached from steel slag" },
  { field: "intelfield", term: "OSINT signal",
    definition: "an open-source-intelligence observation carrying its provenance" },
  { field: "ledgerfield", term: "k-anonymous aggregate",
    definition: "an aggregate market datum requiring at least k=5 contributors" },
  { field: "finfield", term: "finfield:pe_ttm",
    definition: "trailing-twelve-month price / earnings ratio (a derived concept)" },
];

// The explorer data lives at different paths per host: ../data when the Studio
// is served under the same tree as the explorer (finfield.github.io/web/studio/
// → ../data), /fin/data on the 5mart mount, and the absolute Pages URL as a
// last resort. Try each; fall back to hardcoded reals so the Studio always seeds.
async function fetchFirst(entity) {
  const candidates = [
    `../data/e/${entity}.json`,
    `/fin/data/e/${entity}.json`,
    `https://finfield.github.io/web/data/e/${entity}.json`,
  ];
  for (const url of candidates) {
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (r.ok) return await r.json();
    } catch (_) { /* try next */ }
  }
  return null;
}

async function loadSeedFacts() {
  const facts = [];
  const aapl = await fetchFirst("AAPL_US");
  if (aapl) facts.push(...factsFromDoc(aapl).slice(0, 3));
  const btc = await fetchFirst("BTC_CRYPTO");
  if (btc) facts.push(...factsFromDoc(btc, ["finfield:block_height"]));
  if (!facts.length) facts.push(...FALLBACK_FACTS);
  return facts;
}

// ---------------------------------------------------------------------------
// Render a votable row (a fact OR a knitted term) with ✓/✗ + a live tally.
// ---------------------------------------------------------------------------
function fmtValue(f) {
  const v = String(f.value);
  const scaled = f.scale ? `${v}·10⁻${f.scale}` : v;
  return `${scaled} ${esc(f.unit || "")}`;
}

function votableRow(engine, item) {
  const row = document.createElement("div");
  row.className = "card vrow";
  const isFact = item.kind === "finfact-record";
  const fieldTag = `<span class="field-tag ${esc(item.field)}">${esc(item.field)}</span>`;
  let head, body, prov;
  if (isFact) {
    head = `${fieldTag}<span class="tk">${esc(item.ticker || item.entity)}</span>
            <span class="cc">${esc(item.concept)}</span>`;
    body = `<div class="v">${fmtValue(item)}</div>`;
    const src = (item.source && item.source.kind) || "unknown";
    prov = `source ${esc(src)} · period ${esc(item.period_end || "")}`;
  } else {
    head = `${fieldTag}<span class="tk">${esc(item.term)}</span>
            <span class="cc">knit-term</span>`;
    body = `<div class="v defn">${esc(item.definition || "(no definition)")}</div>`;
    prov = `signed term in the ${esc(item.field)} knitweb`;
  }
  row.innerHTML = `
    <div class="vhead">${head}</div>
    ${body}
    <div class="prov">${prov} · <span class="cid" title="${esc(item.cid)}">${esc(shortCid(item.cid))}</span></div>
    <div class="vote-row">
      <button class="btn good vote-yes">✓ correct</button>
      <button class="btn bad vote-no">✗ incorrect</button>
      <span class="tally">no verdict yet</span>
    </div>`;
  const tallyEl = row.querySelector(".tally");
  const paint = (t) => {
    const v = t.verdict === true ? "✓ correct" : t.verdict === false ? "✗ incorrect" : "— tie";
    tallyEl.textContent = `yes ${t.yes} · no ${t.no} · signers ${t.voters} · verdict ${v}`;
    tallyEl.className = "tally " + (t.verdict === true ? "good" : t.verdict === false ? "bad" : "");
  };
  const castVote = async (correct) => {
    try {
      const res = await engine.verdict(item.cid, correct);
      paint(res);
      toast(`signed verdict woven · ${shortCid(res.cid, 12)} (one vote per signer)`, "good");
    } catch (e) { toast("verdict failed: " + e.message, "bad"); }
  };
  row.querySelector(".vote-yes").addEventListener("click", () => castVote(true));
  row.querySelector(".vote-no").addEventListener("click", () => castVote(false));
  return row;
}

function prependVotable(engine, item) {
  $("verify-empty")?.remove();
  $("verify-list").prepend(votableRow(engine, item));
}

// ---------------------------------------------------------------------------
// Wire the Studio UI to the engine.
// ---------------------------------------------------------------------------
async function wireStudio(engine) {
  // Account.
  const acct = await engine.account();
  $("acct-address").textContent = acct.address;
  $("acct-pubkey").textContent = acct.pubkey;

  // Field picker.
  const setField = (field) => {
    currentField = field;
    for (const b of document.querySelectorAll(".field-btn"))
      b.classList.toggle("on", b.dataset.field === field);
    $("k-field-label").textContent = field;
    // The integer-only fact path is finfield-only.
    $("propose-section").classList.toggle("hidden", field !== "finfield");
  };
  for (const b of document.querySelectorAll(".field-btn"))
    b.addEventListener("click", () => setField(b.dataset.field));
  setField("finfield");

  // Knit a term (generic, works for every field).
  $("knit-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const term = {
      field: currentField,
      term: $("k-term").value.trim(),
      definition: $("k-definition").value.trim(),
    };
    const rel = $("k-rel").value.trim(), target = $("k-target").value.trim();
    if (rel && target) term.relations = [{ rel, target }];
    const btn = ev.target.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const res = await engine.knit(term);
      prependVotable(engine, res);
      toast(`knit "${res.term}" into ${res.field} · CID ${shortCid(res.cid, 12)}`, "good");
      $("k-term").value = ""; $("k-definition").value = "";
      $("k-rel").value = ""; $("k-target").value = "";
    } catch (e) {
      toast("knit rejected: " + e.message, "bad");
    } finally { btn.disabled = false; }
  });

  // Propose a finfield fact (integer-only path).
  $("propose-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fact = {
      entity: $("f-entity").value.trim(),
      concept: $("f-concept").value.trim(),
      value: $("f-value").value.trim(),
      scale: $("f-scale").value.trim() || 0,
      unit: $("f-unit").value.trim(),
      period: { end: $("f-period").value.trim() },
      source: { kind: $("f-source-kind").value.trim() || "manual",
                ref: $("f-source-ref").value.trim(),
                fetched: new Date().toISOString().slice(0, 10) },
    };
    const btn = ev.target.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const res = await engine.propose(fact);
      prependVotable(engine, res);
      toast("fact woven & signed · CID " + shortCid(res.cid, 14), "good");
      ev.target.reset();
    } catch (e) {
      toast("rejected: " + e.message, "bad");
    } finally { btn.disabled = false; }
  });

  // Seed the "to verify" list: real finfield facts + example terms per field.
  const list = $("verify-list");
  list.innerHTML = "";
  try {
    const seededFacts = await engine.seedFacts(await loadSeedFacts());
    for (const f of (seededFacts.facts || [])) if (!f.error) list.appendChild(votableRow(engine, f));
    const seededTerms = await engine.seedTerms(SEED_TERMS);
    for (const t of (seededTerms.terms || [])) if (!t.error) list.appendChild(votableRow(engine, t));
  } catch (e) { toast("seed failed: " + e.message, "bad"); }
  if (!list.children.length)
    list.innerHTML = '<p id="verify-empty" class="dim">nothing to verify yet — knit a term above.</p>';

  // Download.
  $("download-btn").addEventListener("click", async () => {
    try {
      const out = await engine.export();
      const blob = new Blob([out.jsonl || ""], { type: "application/x-ndjson" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "studio-weave.jsonl";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast(`downloaded ${out.count} woven records`, "good");
    } catch (e) { toast("export failed: " + e.message, "bad"); }
  });

  // Expose for tests / console.
  window.FINFIELD_STUDIO = { engine, account: acct };
}

// ---------------------------------------------------------------------------
// Boot sequence.
// ---------------------------------------------------------------------------
async function main() {
  bootProgress(4, "spawning engine worker…");
  const worker = spawnEngineWorker();
  const engine = new Engine(worker);

  // Wait for the engine to report ready. A boot-error rejects IMMEDIATELY; the
  // watchdog is only for a genuine hang.
  await Promise.race([
    engine.ready,
    new Promise((_, rej) => setTimeout(() => rej(new Error("engine boot timed out")), 150000)),
  ]).catch((err) => { bootError(String(err.message || err)); throw err; });

  await wireStudio(engine);
  bootDone();
}

main().catch((err) => {
  bootError("Fatal: " + (err && err.message ? err.message : String(err)));
  console.error(err);
});
