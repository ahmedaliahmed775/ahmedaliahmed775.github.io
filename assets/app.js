/* Atheer Test Lab — browser-only mock simulator (no server) with offline FSM simulation */

const $ = (id) => document.getElementById(id);

// Tab names used in UI switching
const TABS = ["lab","results","logs","artifacts","map","local"];

// Application state
const state = {
  currentRun: null,
  logs: [],
  runs: loadRuns(),
  tokenPools: {} // map scenario.id -> pool of tokens and offline total
};

/**
 * Helpers
 */

function nowIso(){
  return new Date().toISOString();
}

// simple deterministic hash for scenario ID
function hashId(input){
  let h = 2166136261;
  for (let i=0;i<input.length;i++){
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return "SCN-" + (h >>> 0).toString(16).toUpperCase().padStart(8,"0");
}

// seeded random generator (mulberry32)
function seededRand(seed){
  let t = seed >>> 0;
  return function(){
    t += 0x6D2B79F5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(arr, p){
  if (!arr.length) return 0;
  const a = [...arr].sort((x,y)=>x-y);
  const idx = Math.ceil((p/100) * a.length) - 1;
  return a[Math.max(0, Math.min(a.length-1, idx))];
}

function mean(arr){
  if (!arr.length) return 0;
  let s=0;
  for (const x of arr) s += x;
  return s / arr.length;
}

function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }

// Logging helper
function log(comp, msg, meta = {}){
  const entry = { t: nowIso(), comp, msg, meta };
  state.logs.push(entry);
  renderLogs();
}

function clearLogs(){
  state.logs = [];
  renderLogs();
}

// persistence for runs
function saveRuns(){
  localStorage.setItem("atheer_runs_v2", JSON.stringify(state.runs.slice(-20)));
}

function loadRuns(){
  try{
    const raw = localStorage.getItem("atheer_runs_v2");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  }catch{
    return [];
  }
}

// UI: tab switching
function setTab(tab){
  for (const t of TABS){
    const btn = document.querySelector(`.tab[data-tab="${t}"]`);
    const panel = $("tab-"+t);
    if (t === tab){
      btn?.classList.add("active");
      panel?.classList.add("show");
    }else{
      btn?.classList.remove("active");
      panel?.classList.remove("show");
    }
  }
}

// Build scenario object from UI
function getScenario(){
  const scenario = {
    netType: $("netType").value,
    latency: Number($("latency").value || 0),
    jitter: Number($("jitter").value || 0),
    loss: Number($("loss").value || 0),
    bw: Number($("bw").value || 0),
    mix: $("mix").value,
    n: Number($("n").value || 1000),
    seed: Number($("seed").value || 42),
  };

  scenario.latency = clamp(scenario.latency, 0, 5000);
  scenario.jitter = clamp(scenario.jitter, 0, 2000);
  scenario.loss = clamp(scenario.loss, 0, 30);
  scenario.bw = clamp(scenario.bw, 64, 1000000);
  scenario.n = clamp(scenario.n, 10, 200000);
  scenario.seed = clamp(scenario.seed, 1, 2147483647);

  scenario.id = hashId(JSON.stringify(scenario));
  return scenario;
}

/**
 * Offline token pool and risk checks (Phase 2)
 *
 * Each scenario has its own pool of tokens. Each token has:
 *  - id: unique string
 *  - used: whether it has been used
 *  - expiresAt: timestamp when token expires
 *  - amount: amount this token can be used for (for simplicity we fix amount=1)
 *
 * We also track the cumulative offline amount per scenario. A limit ensures the total offline amount does not exceed a threshold.
 */
function initTokenPool(scenario){
  // create pool with 100 tokens valid for 3 days
  const tokens = [];
  const now = Date.now();
  for (let i=0; i<100; i++){
    tokens.push({ id: `T${i+1}`, used: false, expiresAt: now + ((3 + Math.random()) * 24 * 60 * 60 * 1000) });
  }
  state.tokenPools[scenario.id] = {
    tokens,
    cumulative: 0,
    limit: 100, // maximum offline transactions allowed before requiring online sync
    threshold: 100 // same as limit for simplicity
  };
  log("token", "Initialized token pool", { scenario: scenario.id, tokens: tokens.length });
}

function riskCheck(scenario, amount){
  // ensure pool exists
  let pool = state.tokenPools[scenario.id];
  if (!pool){
    initTokenPool(scenario);
    pool = state.tokenPools[scenario.id];
  }

  // find next valid token
  const token = pool.tokens.find(t => !t.used && t.expiresAt > Date.now());
  if (!token){
    log("risk", "Token expired or exhausted", { scenario: scenario.id });
    return false;
  }

  // check cumulative limit
  if (pool.cumulative + amount > pool.limit){
    log("risk", "Cumulative limit exceeded", { scenario: scenario.id, cumulative: pool.cumulative, amount });
    return false;
  }

  // token is valid; mark used and increment cumulative amount
  token.used = true;
  pool.cumulative += amount;
  log("risk", "Token consumed", { scenario: scenario.id, token: token.id, newCumulative: pool.cumulative });
  return true;
}

/**
 * Render KPI values in the UI
 */
function renderKpis(run){
  if (!run){
    $("kpiAvg").textContent = "—";
    $("kpiP95").textContent = "—";
    $("kpiErr").textContent = "—";
    $("kpiRetry").textContent = "—";
    return;
  }
  $("kpiAvg").textContent = Math.round(run.metrics.avg_ms).toString();
  $("kpiP95").textContent = Math.round(run.metrics.p95_ms).toString();
  $("kpiErr").textContent = (run.metrics.error_rate * 100).toFixed(2);
  $("kpiRetry").textContent = (run.metrics.retry_rate * 100).toFixed(2);
}

/**
 * Draw a simple line chart for latency samples
 */
function drawChart(samples){
  const c = $("chart");
  const ctx = c.getContext("2d");
  ctx.clearRect(0,0,c.width,c.height);

  const pad = 30;
  const w = c.width, h = c.height;
  const innerW = w - pad*2;
  const innerH = h - pad*2;

  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;

  // grid lines
  ctx.strokeStyle = "rgba(157,176,199,.25)";
  for (let i=0;i<=5;i++){
    const y = pad + (innerH/5)*i;
    ctx.beginPath(); ctx.moveTo(pad,y); ctx.lineTo(w-pad,y); ctx.stroke();
  }

  if (!samples || samples.length === 0){
    ctx.fillStyle = "rgba(157,176,199,.8)";
    ctx.font = "14px system-ui";
    ctx.fillText("شغّل اختبار لعرض الرسم", pad, pad+18);
    return;
  }

  const max = Math.max(...samples);
  const min = Math.min(...samples);
  const range = Math.max(1, max-min);

  const maxPoints = 800;
  const step = Math.max(1, Math.floor(samples.length / maxPoints));
  const pts = [];
  for (let i=0;i<samples.length;i+=step) pts.push(samples[i]);

  ctx.strokeStyle = "rgba(110,231,255,.85)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i=0;i<pts.length;i++){
    const x = pad + (i/(pts.length-1)) * innerW;
    const y = pad + (1 - (pts[i]-min)/range) * innerH;
    if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  }
  ctx.stroke();

  ctx.fillStyle = "rgba(157,176,199,.85)";
  ctx.font = "12px system-ui";
  ctx.fillText(`min ${Math.round(min)}ms`, pad, h-10);
  ctx.fillText(`max ${Math.round(max)}ms`, w-pad-90, h-10);
}

/**
 * Render the runs table
 */
function renderRunsTable(){
  const tb = $("runsTbody");
  if (!tb) return;
  tb.innerHTML = "";
  const runs = [...state.runs].reverse();
  for (const r of runs){
    const tr = document.createElement("tr");
    const t = new Date(r.started_at).toLocaleString();
    const openBtn = `<button class="btn" data-open="${r.run_id}">فتح</button>`;
    tr.innerHTML = `
      <td>${t}</td>
      <td><span class="pill">${r.scenario.id}</span></td>
      <td>${r.scenario.n}</td>
      <td>${Math.round(r.metrics.avg_ms)}ms</td>
      <td>${Math.round(r.metrics.p95_ms)}ms</td>
      <td>${Math.round(r.metrics.p99_ms)}ms</td>
      <td>${(r.metrics.error_rate*100).toFixed(2)}%</td>
      <td>${(r.metrics.retry_rate*100).toFixed(2)}%</td>
      <td>${openBtn}</td>
    `;
    tb.appendChild(tr);
  }
  tb.querySelectorAll("button[data-open]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const id = btn.getAttribute("data-open");
      const run = state.runs.find(x=>x.run_id===id);
      if (!run) return;
      state.currentRun = run;
      $("scenarioIdPill").textContent = `Scenario: ${run.scenario.id}`;
      renderKpis(run);
      drawChart(run.samples_ms);
      log("client", `Opened run ${id}`, { scenario: run.scenario.id });
      setTab("lab");
    });
  });
}

/**
 * Render logs using filters
 */
function renderLogs(){
  const box = $("logBox"); if (!box) return;
  const comp = $("logComp")?.value || "all";
  const q = ($("logSearch")?.value || "").trim().toLowerCase();
  const filtered = state.logs.filter(l=>{
    const okComp = (comp==="all") || (l.comp===comp);
    const okQ = !q || (l.msg.toLowerCase().includes(q) || JSON.stringify(l.meta).toLowerCase().includes(q));
    return okComp && okQ;
  });
  box.textContent = filtered.map(l=>{
    const meta = Object.keys(l.meta||{}).length ? ` ${JSON.stringify(l.meta)}` : "";
    return `[${l.t}] (${l.comp}) ${l.msg}${meta}`;
  }).join("\n");
  box.scrollTop = box.scrollHeight;
}

/**
 * Simulate a single run with offline risk checks and network conditions
 */
function simulateRun(scenario){
  const rand = seededRand(scenario.seed);
  const samples = [];
  let errors = 0;
  let retries = 0;

  log("client", "Run started", { scenario: scenario.id, n: scenario.n, seed: scenario.seed });
  log("network", "Applying network profile", {
    netType: scenario.netType,
    latency: scenario.latency,
    jitter: scenario.jitter,
    loss: scenario.loss,
    bw: scenario.bw
  });

  // base processing time depends on transaction mix
  const baseProcessing = scenario.mix==="tap_to_pay" ? 85 : scenario.mix==="provisioning" ? 160 : 120;

  for (let i=0;i<scenario.n;i++){
    // Each transaction is assumed to be worth 1 unit for risk check
    const amount = 1;
    // offline risk check (Phase 2). If fails, treat as error and continue
    if (!riskCheck(scenario, amount)){
      errors++;
      samples.push(0);
      continue;
    }
    // simulate network conditions
    const drop = rand() < (scenario.loss/100);
    const jitter = (rand()*2 - 1) * scenario.jitter;
    const net = scenario.latency + jitter;
    const payloadKbits = scenario.mix==="provisioning" ? 48 : 12;
    const bwMs = (payloadKbits / scenario.bw) * 1000 * 8; // convert to ms

    let t = baseProcessing + net + bwMs;
    let err = false;

    if (drop){
      retries++;
      // second attempt
      const secondFail = rand() < 0.12;
      t += scenario.latency + Math.abs((rand()*2-1)*scenario.jitter) + 40;
      err = secondFail;
    } else {
      err = rand() < 0.008;
    }

    // additional latency due to stress
    const stress = clamp((scenario.loss/30) + (scenario.latency/800) + (scenario.jitter/400), 0, 1);
    if (rand() < stress*0.35) t += 35 + rand()*90;

    if (err){
      errors++;
      log("host", "Transaction failed", { i, reason: "mock_error" });
    } else if (drop){
      log("network", "Retry succeeded after packet loss", { i });
    }

    t = Math.max(0, t);
    samples.push(t);
  }

  const metrics = {
    avg_ms: mean(samples),
    p50_ms: percentile(samples, 50),
    p95_ms: percentile(samples, 95),
    p99_ms: percentile(samples, 99),
    error_rate: errors / scenario.n,
    retry_rate: retries / scenario.n
  };

  log("risk", "Metrics computed", metrics);
  log("client", "Run finished", { scenario: scenario.id });

  return { samples, metrics, errors, retries };
}

// Utility to download blob as file
function downloadBlob(filename, blob){
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Convert run to CSV string
function runToCsv(run){
  const lines = ["i,latency_ms"];
  run.samples_ms.forEach((v,i)=> lines.push(`${i},${v.toFixed(3)}`));
  return lines.join("\n");
}

function ensureRun(){
  if (!state.currentRun){
    alert("شغّل اختبار أولاً (Run) لتوليد النتائج والملفات.");
    return null;
  }
  return state.currentRun;
}

// PDF export using jsPDF
function exportPdf(run){
  const { jsPDF } = window.jspdf || {};
  if (!jsPDF){ alert("PDF library not loaded."); return; }
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pad = 44;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("Atheer Suite — Evidence Pack", pad, 60);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.text(`Run ID: ${run.run_id}`, pad, 86);
  doc.text(`Scenario: ${run.scenario.id}`, pad, 104);
  doc.text(`Started: ${new Date(run.started_at).toLocaleString()}`, pad, 122);
  doc.setFont("helvetica", "bold");
  doc.text("Scenario Config", pad, 152);
  doc.setFont("helvetica", "normal");
  const cfg = run.scenario;
  const cfgLines = [
    `Network: ${cfg.netType}`,
    `Latency: ${cfg.latency}ms, Jitter: ${cfg.jitter}ms, Loss: ${cfg.loss}%`,
    `Bandwidth: ${cfg.bw}kbps, Mix: ${cfg.mix}`,
    `n=${cfg.n}, seed=${cfg.seed}`
  ];
  doc.text(cfgLines, pad, 172);
  doc.setFont("helvetica", "bold");
  doc.text("Metrics", pad, 238);
  doc.setFont("helvetica", "normal");
  const m = run.metrics;
  const metricLines = [
    `AVG: ${Math.round(m.avg_ms)}ms`,
    `P50: ${Math.round(m.p50_ms)}ms`,
    `P95: ${Math.round(m.p95_ms)}ms`,
    `P99: ${Math.round(m.p99_ms)}ms`,
    `Error Rate: ${(m.error_rate*100).toFixed(2)}%`,
    `Retry Rate: ${(m.retry_rate*100).toFixed(2)}%`
  ];
  doc.text(metricLines, pad, 258);
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text("Note: This is a browser-based mock simulation for research demonstration & reproducibility.", pad, 760);
  doc.save(`atheer_evidence_${run.scenario.id}_${run.run_id}.pdf`);
}

/**
 * Wire up UI events
 */
function wireUi(){
  document.querySelectorAll(".tab").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      setTab(btn.getAttribute("data-tab"));
    });
  });
  $("saveScenarioBtn").addEventListener("click", ()=>{
    const sc = getScenario();
    $("scenarioIdPill").textContent = `Scenario: ${sc.id}`;
    log("client", "Scenario saved (in UI)", { scenario: sc.id });
  });
  $("runBtn").addEventListener("click", ()=>{
    const sc = getScenario();
    $("scenarioIdPill").textContent = `Scenario: ${sc.id}`;
    const sim = simulateRun(sc);
    const run = {
      run_id: "RUN-" + Math.random().toString(16).slice(2,10).toUpperCase(),
      started_at: nowIso(),
      scenario: sc,
      metrics: sim.metrics,
      samples_ms: sim.samples
    };
    state.currentRun = run;
    state.runs.push(run);
    state.runs = state.runs.slice(-20);
    saveRuns();
    renderKpis(run);
    drawChart(run.samples_ms);
    renderRunsTable();
    log("client", "Run stored", { run_id: run.run_id, scenario: sc.id });
  });
  $("logComp").addEventListener("change", renderLogs);
  $("logSearch").addEventListener("input", renderLogs);
  $("exportLogsBtn").addEventListener("click", ()=>{
    const data = JSON.stringify(state.logs, null, 2);
    downloadBlob("atheer_logs.json", new Blob([data], {type:"application/json"}));
  });
  $("clearLogsBtn").addEventListener("click", clearLogs);
  $("downloadCsvBtn").addEventListener("click", ()=>{
    const run = ensureRun(); if (!run) return;
    downloadBlob(`atheer_${run.scenario.id}_${run.run_id}.csv`, new Blob([runToCsv(run)], {type:"text/csv"}));
  });
  $("downloadJsonBtn").addEventListener("click", ()=>{
    const run = ensureRun(); if (!run) return;
    downloadBlob(`atheer_${run.scenario.id}_${run.run_id}.json`, new Blob([JSON.stringify(run, null, 2)], {type:"application/json"}));
  });
  $("downloadPdfBtn").addEventListener("click", ()=>{
    const run = ensureRun(); if (!run) return;
    exportPdf(run);
  });
  $("clearRunsBtn").addEventListener("click", ()=>{
    if (!confirm("متأكد تريد حذف كل التشغيلات؟")) return;
    state.runs = [];
    saveRuns();
    renderRunsTable();
    log("client", "All runs cleared");
  });
  $("exportRunsJsonBtn").addEventListener("click", ()=>{
    downloadBlob("atheer_all_runs.json", new Blob([JSON.stringify(state.runs, null, 2)], {type:"application/json"}));
  });
}

(function init(){
  wireUi();
  setTab("lab");
  renderRunsTable();
  renderKpis(state.currentRun);
  drawChart([]);
  log("client", "Atheer Test Lab loaded");
})();
