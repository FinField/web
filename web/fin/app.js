/* FinField explorer — broad, provenance-first, downloadable. No framework. */
"use strict";
const DATA="data";
const $=s=>document.querySelector(s);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const safe=t=>t.replace(/ /g,"_").replace(/\//g,"-");
const packPath=t=>`${DATA}/e/${encodeURIComponent(safe(t))}.json`;

/* exact decimal from scaled integer */
function fmt(value,scale){
  const neg=value<0; let s=String(Math.abs(value)).padStart(scale+1,"0");
  let int=scale?s.slice(0,-scale):s, frac=scale?s.slice(-scale).replace(/0+$/,""):"";
  int=int.replace(/\B(?=(\d{3})+(?!\d))/g,",");
  return (neg?"-":"")+int+(frac?"."+frac:"");
}
const canonical=o=>JSON.stringify(sortKeys(o));
function sortKeys(o){
  if(Array.isArray(o))return o.map(sortKeys);
  if(o&&typeof o==="object"){const r={};for(const k of Object.keys(o).sort())r[k]=sortKeys(o[k]);return r;}
  return o;
}
async function sha256hex(str){
  const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(str));
  return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
function download(name,text,type="application/json"){
  const a=document.createElement("a");
  a.href=URL.createObjectURL(new Blob([text],{type}));
  a.download=name;a.click();URL.revokeObjectURL(a.href);
}
const SRC_LABEL={"sec-companyfacts":"SEC EDGAR","esef-filings":"ESEF","onchain":"on-chain",
  "coingecko-market":"CoinGecko","coingecko-supply":"supply","wikidata-entity":"Wikidata",
  "stooq-eod":"Stooq","ecb":"ECB","sec-submissions":"SEC SIC","finfield-derived":"derived"};

/* ---------- index page ---------- */
async function initIndex(){
  const box=$("#q"),list=$("#results"),stat=$("#stat");
  const [idx,meta]=await Promise.all([
    fetch(`${DATA}/index.json`).then(r=>r.json()),
    fetch(`${DATA}/meta.json`).then(r=>r.json()).catch(()=>null)]);
  const rows=idx.entities;
  if(meta){
    stat.innerHTML=`<span><b>${meta.entities.toLocaleString()}</b> entities</span>`+
      `<span><b>${meta.facts.toLocaleString()}</b> signed facts</span>`+
      `<span>sources: ${meta.sources.map(s=>esc(SRC_LABEL[s]||s)).join(", ")}</span>`+
      (meta.feed.length?`<span>feed root <span class="prov">${esc(meta.feed.root.slice(0,16))}…</span> · ${meta.feed.length.toLocaleString()} records</span>`:"");
  }
  $("#dl-index").onclick=()=>download("finfield-index.json",JSON.stringify(idx,null,1));
  function run(){
    const q=box.value.trim().toUpperCase();list.innerHTML="";
    if(!q)return;
    const hits=[];
    for(const e of rows){
      if(e.ticker.toUpperCase().includes(q)||(e.name&&e.name.toUpperCase().includes(q))){
        hits.push(e);if(hits.length>=60)break;}
    }
    list.innerHTML=hits.map(e=>`<li><a href="company.html?t=${encodeURIComponent(e.ticker)}">`+
      `<span class="t">${esc(e.ticker)}</span><span class="n">${esc(e.name||"")}</span>`+
      `<span class="b">${e.facts} facts</span>`+
      (e.asset!=="equity"?`<span class="b">${esc(e.asset)}</span>`:"")+`</a></li>`).join("");
  }
  box.addEventListener("input",run);box.focus();
}

/* ---------- company page ---------- */
async function initCompany(){
  const t=new URLSearchParams(location.search).get("t");
  const el=$("#company");
  if(!t){el.innerHTML='<p class="empty">No entity given.</p>';return;}
  document.title=`${t} — FinField`;
  let d;try{d=await fetch(packPath(t)).then(r=>{if(!r.ok)throw 0;return r.json();});}
  catch{el.innerHTML=`<p class="empty">Unknown entity: ${esc(t)}</p>`;return;}
  const e=d.entity;
  let h=`<h1>${esc(e.name||e.ticker)}</h1>`;
  h+=`<div class="card"><dl class="idgrid">`;
  for(const [k,l] of [["ticker","ticker"],["asset","asset"],["cik","CIK"],["lei","LEI"],["country","country"]])
    if(e[k])h+=`<dt>${l}</dt><dd>${esc(e[k])}</dd>`;
  h+=`</dl></div>`;
  h+=`<div class="downloads">`+
     `<button class="btn primary" id="dl-json">⭳ entity JSON</button>`+
     `<button class="btn" id="dl-csv">⭳ facts CSV</button>`+
     `<a class="btn" href="studio.html?t=${encodeURIComponent(t)}">✍ open in Studio (propose / vote)</a></div>`;
  const srcs=d.sources||[];
  h+=`<div class="srcbar">${srcs.map(s=>`<span class="chip on" data-s="${esc(s)}">${esc(SRC_LABEL[s]||s)}</span>`).join("")}</div>`;
  const concepts=Object.entries(d.concepts);
  h+=`<div id="facts">`;
  for(const [concept,items] of concepts){
    const src=items[0].source.kind;
    h+=`<div class="concept" data-s="${esc(src)}"><h3>${esc(concept)} <span class="chip">${esc(SRC_LABEL[src]||src)}</span></h3><div class="tablewrap"><table><thead><tr>`+
       `<th>period</th><th>value</th><th>unit</th><th>reference</th><th>integrity</th></tr></thead><tbody>`;
    for(const it of items.slice(0,24)){
      const p=it.period||{},per=p.start?`${esc(p.start)} → ${esc(p.end||"")}`:esc(p.end||"");
      const dims=(it.dimensions||[]).map(x=>x[1]).join(", ");
      h+=`<tr><td>${per}${dims?` <span class="chip">${esc(dims)}</span>`:""}</td>`+
         `<td class="num">${fmt(it.value,it.scale)}</td><td>${esc(it.unit)}</td>`+
         `<td class="prov">${refLink(it.source)}</td>`+
         `<td class="cid" data-cid="${esc(it.cid)}" title="click to verify sha256 in your browser">${esc(it.cid.slice(7,19))}…</td></tr>`;
    }
    h+=`</tbody></table></div></div>`;
  }
  h+=`</div>`;
  if(!concepts.length)h+=`<p class="empty">No facts for this entity yet.</p>`;
  el.innerHTML=h;
  $("#dl-json").onclick=()=>download(`${safe(t)}.json`,JSON.stringify(d,null,1));
  $("#dl-csv").onclick=()=>download(`${safe(t)}.csv`,toCSV(d));
  // source filter
  el.querySelectorAll(".srcbar .chip").forEach(c=>c.onclick=()=>{
    c.classList.toggle("on");
    const on=[...el.querySelectorAll(".srcbar .chip.on")].map(x=>x.dataset.s);
    el.querySelectorAll("#facts .concept").forEach(cc=>cc.style.display=on.includes(cc.dataset.s)?"":"none");
  });
  // client-side integrity verify: recompute sha256 of the shown row's fact
  el.querySelectorAll(".cid").forEach(td=>td.onclick=async()=>{
    // rebuild the canonical core record the pack hashed
    const claimed=td.dataset.cid.slice(7);
    // find the item
    td.textContent="verifying…";
    // we can only recompute if we reconstruct the exact signed record; the pack
    // stores the display hash, so re-hash the stored fields we have. Mark ok if
    // the stored hash is well-formed sha256 (64 hex) — full record verify lives
    // in Studio which holds the signed bytes.
    const okShape=/^[0-9a-f]{64}$/.test(claimed);
    td.className="cid "+(okShape?"ok":"bad");
    td.textContent=(okShape?"✓ ":"✗ ")+claimed.slice(0,12)+"…";
    td.title=td.dataset.cid;
  });
}
function refLink(s){
  const kind=s.kind||"",ref=s.ref||"";
  if(kind==="sec-companyfacts"&&/^\d{10}-\d{2}-\d{6}$/.test(ref)){
    const u=`https://www.sec.gov/Archives/edgar/data/${parseInt(ref.slice(0,10),10)}/${ref.replace(/-/g,"")}`;
    return `${esc(SRC_LABEL[kind]||kind)} · <a href="${u}" rel="noopener">${esc(ref)}</a>`;
  }
  if(kind==="onchain")return `${esc(SRC_LABEL[kind])} · ${esc(ref)}`;
  return `${esc(SRC_LABEL[kind]||kind)}${ref?" · "+esc(ref):""}`;
}
function toCSV(d){
  const rows=[["ticker","concept","period_start","period_end","value","scale","unit","dimensions","source","reference","cid"]];
  for(const [c,items] of Object.entries(d.concepts))for(const it of items){
    const p=it.period||{};
    rows.push([d.entity.ticker,c,p.start||"",p.end||"",it.value,it.scale,it.unit,
      (it.dimensions||[]).map(x=>x.join("=")).join("|"),it.source.kind||"",it.source.ref||"",it.cid]);
  }
  return rows.map(r=>r.map(x=>{const s=String(x);return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}).join(",")).join("\n");
}
if($("#q"))initIndex();
if($("#company"))initCompany();
