// Plate Planner - local-only, IndexedDB storage

const $ = (id) => document.getElementById(id);

// ---------- IndexedDB tiny helper ----------
const DB_NAME = 'plate_planner_db';
const DB_VERSION = 1;
const STORE = 'kv';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req = store.put(value, key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

async function idbDel(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req = store.delete(key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

// ---------- State ----------
let bars = [];
let plates = [];
let lastComputed = null; // {rowsAll, ...}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : (Math.random().toString(16).slice(2) + Date.now());
}

function toKg(n) {
  const x = Number(String(n).replace(',', '.'));
  return Number.isFinite(x) ? x : null;
}

function toInt(n) {
  const x = parseInt(String(n), 10);
  return Number.isFinite(x) ? x : null;
}

function kgToG(kg) {
  return Math.round(kg * 1000);
}

function gToKg(g) {
  return (g / 1000);
}

function fmtKg(x) {
  return Number(x.toFixed(3)).toString();
}

function setStatus(msg) {
  $('status').textContent = msg || '';
}

// ---------- Rendering lists ----------
function renderBars() {
  const el = $('barsList');
  el.innerHTML = '';
  if (!bars.length) {
    el.innerHTML = '<div class="item"><div><b>No bars yet</b><div class="meta">Add at least one bar.</div></div></div>';
  } else {
    bars.forEach(b => {
      const row = document.createElement('div');
      row.className = 'item';
      row.innerHTML = `
        <div>
          <div><b>${escapeHtml(b.name)}</b> <span class="meta">(${fmtKg(b.weightKg)} kg)</span></div>
          <div class="meta">id: ${b.id}</div>
        </div>
        <div class="row">
          <button data-act="edit" data-id="${b.id}">Edit</button>
          <button data-act="del" data-id="${b.id}" class="danger">Delete</button>
        </div>
      `;
      el.appendChild(row);
    });
  }
  syncBarSelect();
}

function renderPlates() {
  const el = $('platesList');
  el.innerHTML = '';
  if (!plates.length) {
    el.innerHTML = '<div class="item"><div><b>No plates yet</b><div class="meta">Add plates with total counts.</div></div></div>';
  } else {
    [...plates].sort((a,b)=>b.weightKg-a.weightKg).forEach(p => {
      const pairs = Math.floor(p.count / 2);
      const row = document.createElement('div');
      row.className = 'item';
      row.innerHTML = `
        <div>
          <div><b>${fmtKg(p.weightKg)} kg</b> <span class="meta">× ${p.count} total (${pairs} pairs)</span></div>
          <div class="meta">id: ${p.id}</div>
        </div>
        <div class="row">
          <button data-act="edit" data-id="${p.id}">Edit</button>
          <button data-act="del" data-id="${p.id}" class="danger">Delete</button>
        </div>
      `;
      el.appendChild(row);
    });
  }
}

function syncBarSelect() {
  const sel = $('barSelect');
  const prev = sel.value;
  sel.innerHTML = '';
  bars.forEach(b => {
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = `${b.name} (${fmtKg(b.weightKg)} kg)`;
    sel.appendChild(opt);
  });
  if (bars.length) {
    sel.value = bars.some(b=>b.id===prev) ? prev : bars[0].id;
  }
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---------- DP: best (fewest plates) per-side combos ----------
function computeBestPerSide(platesSpec) {
  const maxSumG = platesSpec.reduce((acc,p)=>acc + p.weightG * p.pairsMax, 0);

  // dp[sumG] -> Node
  // Node = {platesCount, typesCount, plateIdx, usedPairs, prev}
  const dp = new Array(maxSumG + 1).fill(null);
  dp[0] = { platesCount: 0, typesCount: 0, plateIdx: -1, usedPairs: 0, prev: null };

  for (let i=0; i<platesSpec.length; i++) {
    const {weightG, pairsMax} = platesSpec[i];
    const next = dp.slice();

    for (let sum=0; sum<=maxSumG; sum++) {
      const node = dp[sum];
      if (!node) continue;
      for (let k=1; k<=pairsMax; k++) {
        const ns = sum + k*weightG;
        if (ns>maxSumG) break;
        const cand = {
          platesCount: node.platesCount + k,
          typesCount: node.typesCount + 1,
          plateIdx: i,
          usedPairs: k,
          prev: node,
        };
        const best = next[ns];
        if (!best || better(cand, best)) {
          next[ns] = cand;
        }
      }
    }
    for (let s=0; s<=maxSumG; s++) dp[s] = next[s];
  }

  const results = [];
  for (let sum=0; sum<=maxSumG; sum++) {
    const node = dp[sum];
    if (!node) continue;
    results.push({ sumG: sum, node });
  }

  return { maxSumG, reachable: results, dp };
}

function better(a,b) {
  if (a.platesCount !== b.platesCount) return a.platesCount < b.platesCount;
  if (a.typesCount !== b.typesCount) return a.typesCount < b.typesCount;
  return false; // stable tie
}

function reconstruct(node, platesSpec) {
  const countsPairs = new Array(platesSpec.length).fill(0);
  let cur = node;
  while (cur && cur.plateIdx >= 0) {
    countsPairs[cur.plateIdx] = cur.usedPairs;
    cur = cur.prev;
  }
  return countsPairs;
}

// ---------- Build total weights table for a selected bar ----------
function buildRowsForBar(bar, platesSpec, dpOut) {
  const rows = [];
  for (const r of dpOut.reachable) {
    const sideG = r.sumG;
    const totalG = kgToG(bar.weightKg) + 2*sideG;
    const sideKg = gToKg(sideG);
    const totalKg = gToKg(totalG);

    const pairs = reconstruct(r.node, platesSpec);
    const perSide = [];
    let platesPerSide = 0;
    for (let i=0; i<pairs.length; i++) {
      const k = pairs[i];
      if (k>0) {
        perSide.push({weightKg: platesSpec[i].weightKg, count: k});
        platesPerSide += k;
      }
    }
    perSide.sort((a,b)=>b.weightKg - a.weightKg);
    rows.push({ totalKg, sideKg, platesPerSide, platesTotal: platesPerSide*2, perSide });
  }
  rows.sort((a,b)=>a.totalKg - b.totalKg);
  return rows;
}

function renderTable(rows, minTotalKg=null, maxTotalKg=null) {
  const tbody = $('results').querySelector('tbody');
  tbody.innerHTML = '';

  const filtered = rows.filter(r => {
    if (minTotalKg!=null && r.totalKg < minTotalKg - 1e-9) return false;
    if (maxTotalKg!=null && r.totalKg > maxTotalKg + 1e-9) return false;
    return true;
  });

  for (const r of filtered) {
    const tr = document.createElement('tr');
    const breakdown = r.perSide.length
      ? r.perSide.map(p => `${p.count}×${fmtKg(p.weightKg)}kg`).join(' + ')
      : '— (empty bar)';

    tr.innerHTML = `
      <td>${fmtKg(r.totalKg)}</td>
      <td>${fmtKg(r.sideKg)}</td>
      <td>${r.platesPerSide}</td>
      <td>${r.platesTotal}</td>
      <td>${breakdown}</td>
    `;
    tbody.appendChild(tr);
  }

  setStatus(`${filtered.length} weights shown.`);
  lastComputed = { ...(lastComputed||{}), rowsFiltered: filtered };
}

// ---------- CSV Export ----------
function toCsv(rows) {
  const header = ['total_kg','per_side_kg','plates_per_side','plates_total','per_side_breakdown'];
  const lines = [header.join(',')];
  for (const r of rows) {
    const breakdown = r.perSide.length
      ? r.perSide.map(p => `${p.count}x${fmtKg(p.weightKg)}kg`).join(' + ')
      : '';
    const line = [fmtKg(r.totalKg), fmtKg(r.sideKg), r.platesPerSide, r.platesTotal, `"${breakdown}"`];
    lines.push(line.join(','));
  }
  return lines.join('\n');
}

function download(filename, text) {
  const blob = new Blob([text], {type:'text/plain'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------- Compute handler ----------
function getSelectedBar() {
  const id = $('barSelect').value;
  return bars.find(b=>b.id===id) || null;
}

function normalizePlates() {
  // merge same weights
  const map = new Map();
  for (const p of plates) {
    const key = String(p.weightKg);
    map.set(key, (map.get(key)||0) + p.count);
  }
  const out = [];
  for (const [k,count] of map.entries()) {
    const w = Number(k);
    out.push({ id: uuid(), weightKg: w, count });
  }
  return out;
}

function compute() {
  const bar = getSelectedBar();
  if (!bar) { setStatus('Add/select a bar first.'); return; }
  if (!plates.length) { setStatus('Add plates first.'); return; }

  const platesNorm = normalizePlates();

  const platesSpec = platesNorm
    .map(p => ({
      weightKg: p.weightKg,
      weightG: kgToG(p.weightKg),
      pairsMax: Math.floor(p.count / 2)
    }))
    .filter(p => p.pairsMax > 0)
    .sort((a,b)=>b.weightG - a.weightG);

  if (!platesSpec.length) { setStatus('No usable pairs found (need at least 2 plates of a weight).'); return; }

  setStatus('Computing…');

  const dpOut = computeBestPerSide(platesSpec);
  const rows = buildRowsForBar(bar, platesSpec, dpOut);

  const minTotalKg = toKg($('minTotal').value);
  const maxTotalKg = toKg($('maxTotal').value);

  renderTable(rows, minTotalKg, maxTotalKg);
  lastComputed = { rowsAll: rows, bar, platesSpec, rowsFiltered: lastComputed?.rowsFiltered };

  setStatus(`Computed ${rows.length} possible totals for “${bar.name}”.`);
}

function findClosest() {
  const bar = getSelectedBar();
  if (!bar || !lastComputed?.rowsAll) {
    compute();
  }
  const target = toKg($('targetTotal').value);
  if (target == null) { setStatus('Enter a target total weight (kg).'); return; }

  const rows = lastComputed.rowsAll;
  let best = null;
  for (const r of rows) {
    const d = Math.abs(r.totalKg - target);
    if (!best || d < best.d || (d === best.d && r.platesTotal < best.row.platesTotal)) {
      best = { d, row: r };
    }
  }
  if (!best) { setStatus('No weights found.'); return; }

  $('minTotal').value = fmtKg(best.row.totalKg);
  $('maxTotal').value = fmtKg(best.row.totalKg);
  renderTable(rows, best.row.totalKg, best.row.totalKg);
  setStatus(`Closest to ${fmtKg(target)} kg: ${fmtKg(best.row.totalKg)} kg (Δ ${fmtKg(best.d)} kg).`);
}

// ---------- CRUD handlers ----------
function addBar() {
  const name = $('barName').value.trim() || 'Bar';
  const w = toKg($('barWeight').value);
  if (w == null || w <= 0) { setStatus('Enter a valid bar weight in kg.'); return; }
  bars.push({ id: uuid(), name, weightKg: w });
  $('barName').value = '';
  $('barWeight').value = '';
  renderBars();
  setStatus('Bar added (not yet saved).');
}

function addPlate() {
  const w = toKg($('plateWeight').value);
  const c = toInt($('plateCount').value);
  if (w == null || w <= 0) { setStatus('Enter a valid plate weight in kg.'); return; }
  if (c == null || c <= 0) { setStatus('Enter a valid plate count.'); return; }
  plates.push({ id: uuid(), weightKg: w, count: c });
  $('plateWeight').value = '';
  $('plateCount').value = '';
  renderPlates();
  setStatus('Plate added (not yet saved).');
}

$('barsList').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const id = btn.dataset.id;
  const act = btn.dataset.act;
  const b = bars.find(x=>x.id===id);
  if (!b) return;
  if (act==='del') {
    bars = bars.filter(x=>x.id!==id);
    renderBars();
    setStatus('Bar deleted (not yet saved).');
  }
  if (act==='edit') {
    const name = prompt('Bar name', b.name);
    if (name===null) return;
    const wStr = prompt('Bar weight (kg)', String(b.weightKg));
    if (wStr===null) return;
    const w = toKg(wStr);
    if (w==null || w<=0) { setStatus('Invalid weight.'); return; }
    b.name = name.trim() || b.name;
    b.weightKg = w;
    renderBars();
    setStatus('Bar updated (not yet saved).');
  }
});

$('platesList').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const id = btn.dataset.id;
  const act = btn.dataset.act;
  const p = plates.find(x=>x.id===id);
  if (!p) return;
  if (act==='del') {
    plates = plates.filter(x=>x.id!==id);
    renderPlates();
    setStatus('Plate deleted (not yet saved).');
  }
  if (act==='edit') {
    const wStr = prompt('Plate weight (kg)', String(p.weightKg));
    if (wStr===null) return;
    const cStr = prompt('Plate count (total)', String(p.count));
    if (cStr===null) return;
    const w = toKg(wStr);
    const c = toInt(cStr);
    if (w==null || w<=0 || c==null || c<=0) { setStatus('Invalid values.'); return; }
    p.weightKg = w;
    p.count = c;
    renderPlates();
    setStatus('Plate updated (not yet saved).');
  }
});

async function saveAll() {
  await idbSet('bars', bars);
  await idbSet('plates', plates);
  setStatus('Saved to IndexedDB.');
}

async function loadAll() {
  const b = await idbGet('bars');
  const p = await idbGet('plates');
  bars = Array.isArray(b) ? b : [];
  plates = Array.isArray(p) ? p : [];
  renderBars();
  renderPlates();
  setStatus('Loaded from IndexedDB.');
}

async function resetAll() {
  if (!confirm('Delete all stored data (bars & plates) from this browser?')) return;
  bars = [];
  plates = [];
  await idbDel('bars');
  await idbDel('plates');
  renderBars();
  renderPlates();
  $('results').querySelector('tbody').innerHTML='';
  setStatus('Reset complete.');
}

// ---------- Wire up buttons ----------
$('addBar').addEventListener('click', addBar);
$('addPlate').addEventListener('click', addPlate);
$('save').addEventListener('click', saveAll);
$('load').addEventListener('click', loadAll);
$('reset').addEventListener('click', resetAll);
$('compute').addEventListener('click', compute);
$('findTarget').addEventListener('click', findClosest);
$('print').addEventListener('click', () => window.print());
$('exportCsv').addEventListener('click', () => {
  if (!lastComputed?.rowsAll) { compute(); }
  const rows = lastComputed?.rowsAll || [];
  const csv = toCsv(rows);
  download('plate-planner.csv', csv);
});

// Initial
(async function init(){
  await loadAll();
  if (!bars.length) {
    bars = [{id: uuid(), name: 'Bar (example 20kg)', weightKg: 20}];
  }
  if (!plates.length) {
    plates = [
      {id: uuid(), weightKg: 10, count: 2},
      {id: uuid(), weightKg: 5, count: 4},
      {id: uuid(), weightKg: 2.5, count: 4},
      {id: uuid(), weightKg: 1.25, count: 4}
    ];
  }
  renderBars();
  renderPlates();
  setStatus('Ready. Add your inventory, save, then compute.');
})();
