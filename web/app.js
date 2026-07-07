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
     `<a class="btn" href="studio/?t=${encodeURIComponent(t)}">✍ open in Studio (propose / vote)</a></div>`;
  h+=signalSection(d.signal);
  const srcs=d.sources||[];
  h+=`<div class="srcbar">${srcs.map(s=>`<span class="chip on" data-s="${esc(s)}">${esc(SRC_LABEL[s]||s)}</span>`).join("")}</div>`;
  const concepts=Object.entries(d.concepts);
  const byCid=new Map();          // cid -> item, for client-side re-hash
  const author=d.author||"";
  h+=`<div id="facts">`;
  for(const [concept,items] of concepts){
    const src=items[0].source.kind;
    h+=`<div class="concept" data-s="${esc(src)}"><h3>${esc(concept)} <span class="chip">${esc(SRC_LABEL[src]||src)}</span></h3><div class="tablewrap"><table><thead><tr>`+
       `<th>period</th><th>value</th><th>unit</th><th>reference</th><th>integrity</th></tr></thead><tbody>`;
    for(const it of items.slice(0,24)){
      byCid.set(it.cid,it);
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
  if(d.signal){ drawTermStructure($("#termchart"), d.signal); $("#dl-signal").onclick=()=>download(`${safe(t)}-signal.json`,JSON.stringify(d.signal,null,1)); }
  $("#dl-json").onclick=()=>download(`${safe(t)}.json`,JSON.stringify(d,null,1));
  $("#dl-csv").onclick=()=>download(`${safe(t)}.csv`,toCSV(d));
  // source filter
  el.querySelectorAll(".srcbar .chip").forEach(c=>c.onclick=()=>{
    c.classList.toggle("on");
    const on=[...el.querySelectorAll(".srcbar .chip.on")].map(x=>x.dataset.s);
    el.querySelectorAll("#facts .concept").forEach(cc=>cc.style.display=on.includes(cc.dataset.s)?"":"none");
  });
  // client-side integrity verify: reconstruct the exact signed record and
  // recompute its sha256 in the browser — the provenance-first promise made real
  el.querySelectorAll(".cid").forEach(td=>td.onclick=async()=>{
    const claimed=td.dataset.cid, it=byCid.get(claimed);
    if(!it){td.className="cid bad";td.textContent="✗ no data";return;}
    td.textContent="verifying…";
    const core={author,concept:it.concept,derived_from:it.derived_from||[],
      entity:"ticker:"+e.ticker,kind:"finfact-record",period:it.period,
      scale:it.scale,source:it.source,unit:it.unit,value:it.value};
    if(it.dimensions&&it.dimensions.length)core.dimensions=it.dimensions;
    const got="sha256:"+await sha256hex(canonical(core));
    const ok=got===claimed;
    td.className="cid "+(ok?"ok":"bad");
    td.textContent=(ok?"✓ verified ":"✗ mismatch ")+claimed.slice(7,19)+"…";
    td.title=ok?`recomputed sha256 matches: ${claimed}`:`recomputed ${got} ≠ stored ${claimed}`;
  });
}
/* ---------- time / risk-factor graph (expected-return term structure) ---------- */
const pct=b=>(b/100).toFixed(1)+"%";
function signalSection(sig){
  if(!sig) return `<h2>Time / risk-factor outlook</h2><p class="empty">No cross-sectional factor coverage for this asset yet (needs free-float mcap + fundamentals). Crypto uses on-chain / momentum — coming.</p>`;
  const d=sig.dominant, e=sig.expected_annual_bps;
  const dir=e>=0?"up":"down", sign=e>=0?"+":"";
  const bars=sig.factors.map(f=>{
    const w=Math.min(100,Math.abs(f.contribution_bps)/6);
    const pos=f.contribution_bps>=0;
    return `<div class="fbar"><span class="fk">${esc(f.label)}</span>`+
      `<span class="ftrack"><span class="ffill ${pos?'pos':'neg'}" style="width:${w}%"></span></span>`+
      `<span class="fv ${pos?'pos':'neg'}">${f.contribution_bps>=0?'+':''}${pct(f.contribution_bps)} · p${f.percentile}</span></div>`;
  }).join("");
  return `<h2>Time / risk-factor outlook</h2>`+
    `<div class="card signal">`+
    `<div class="predict ${dir}"><span class="plabel">Most important signal</span>`+
    `<b>${esc(d.label)}</b> — ${esc(d.direction)} premium, ${d.percentile}ᵗʰ pct`+
    `<span class="exp ${dir}">E[excess] ${sign}${pct(e)}/yr</span></div>`+
    `<canvas id="termchart" height="220"></canvas>`+
    `<div class="factors">${bars}</div>`+
    `<div class="note">Expected-excess term structure from cross-sectional factor exposures. `+
    `Premia are long-run academic estimates per 1σ — a model assumption, not a measured fact. `+
    `<button class="btn" id="dl-signal">⭳ signal JSON</button></div></div>`;
}
function drawTermStructure(cv,sig){
  if(!cv) return;
  const term=sig.term, DPR=window.devicePixelRatio||1;
  const W=cv.clientWidth||cv.parentElement.clientWidth||640, H=220;
  cv.width=W*DPR; cv.height=H*DPR; cv.style.width="100%"; const g=cv.getContext("2d"); g.scale(DPR,DPR);
  const padL=48,padR=14,padT=14,padB=26, iw=W-padL-padR, ih=H-padT-padB;
  const xs=term.map(p=>p.m), maxX=Math.max(...xs);
  const ys=term.flatMap(p=>[p.lo_bps,p.hi_bps,p.mid_bps]);
  let lo=Math.min(...ys,0), hi=Math.max(...ys,0); const span=(hi-lo)||100; lo-=span*0.08; hi+=span*0.08;
  const X=m=>padL+iw*(m/maxX), Y=b=>padT+ih*(1-(b-lo)/(hi-lo));
  const css=getComputedStyle(document.documentElement);
  const line=css.getPropertyValue("--acc").trim()||"#4ea1ff", dim=css.getPropertyValue("--dim").trim()||"#8b98ac";
  g.clearRect(0,0,W,H);
  // zero axis
  g.strokeStyle=css.getPropertyValue("--line").trim()||"#222a3a"; g.lineWidth=1;
  g.beginPath(); g.moveTo(padL,Y(0)); g.lineTo(W-padR,Y(0)); g.stroke();
  // y labels
  g.fillStyle=dim; g.font="11px ui-monospace,monospace"; g.textAlign="right";
  [hi,(hi+lo)/2,lo].forEach(v=>{const y=Y(v); g.fillText((v/100).toFixed(0)+"%",padL-6,y+3);});
  g.textAlign="center"; xs.forEach(m=>{ if(m%6===0) g.fillText(m+"m",X(m),H-8); });
  // band
  g.fillStyle=(line.startsWith("#")?hexA(line,0.15):"rgba(78,161,255,.15)");
  g.beginPath(); term.forEach((p,i)=>{const x=X(p.m),y=Y(p.hi_bps); i?g.lineTo(x,y):g.moveTo(x,y);});
  for(let i=term.length-1;i>=0;i--){const p=term[i]; g.lineTo(X(p.m),Y(p.lo_bps));} g.closePath(); g.fill();
  // mid line
  g.strokeStyle=line; g.lineWidth=2; g.beginPath();
  term.forEach((p,i)=>{const x=X(p.m),y=Y(p.mid_bps); i?g.lineTo(x,y):g.moveTo(x,y);}); g.stroke();
  // endpoint dot + label
  const last=term[term.length-1];
  g.fillStyle=line; g.beginPath(); g.arc(X(last.m),Y(last.mid_bps),3,0,7); g.fill();
  g.textAlign="right"; g.fillStyle=css.getPropertyValue("--fg").trim()||"#e6edf3";
  g.fillText(((last.mid_bps/100).toFixed(1))+"%",X(last.m)-6,Y(last.mid_bps)-6);
}
function hexA(hex,a){const n=parseInt(hex.slice(1),16);return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`;}
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
