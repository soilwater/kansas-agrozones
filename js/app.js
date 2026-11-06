const HUES = [25, 54, 137, 209, 270, 331, 173, 0];      // macrozone hues (degrees)
let META, RAW, CID, N, VALID, cellArea, step = {};
let MAC = null, MIC = null, LAB = null, K1 = 3, K2m = [], STATS = [];
let CROPS = null, CROP = null, KEEP = null, CPX = null;   // county crop areas, chosen crop, kept counties (by county id), county size in pixel-area units

const $ = id => document.getElementById(id);
const gz = url => fetch(url).then(r => { if (!r.ok) throw new Error(url); return new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(); });
Promise.all([fetch('data/meta.json').then(r => r.json()), gz('data/layers.bin.gz'), gz('data/county_id.bin.gz'),
             fetch('data/crops.json').then(r => r.ok ? r.json() : null).catch(() => null)])
  .then(([m, a, c, cr]) => { META = m; RAW = new Uint8Array(a); CID = new Uint8Array(c); CROPS = cr; init(); })
  .catch(e => { $('status').textContent = 'Could not load the layers (serve this folder over http, for example with python -m http.server): ' + e.message; });

// ---------- setup ----------
function init() {
  N = META.rows * META.cols;
  VALID = []; for (let i = 0; i < N; i++) if (RAW[i] !== 255) VALID.push(i);
  const lat0 = META.transform[5], dy = META.transform[4];
  cellArea = VALID.map(i => Math.cos((lat0 + dy * (Math.floor(i / META.cols) + 0.5)) * Math.PI / 180));
  const tb = $('layers');
  META.layers.forEach(L => {
    step[L.key] = L.key === 'ppt' ? 'macro' : 'off';   // start simple: rainfall only, as an example
    const tr = tb.insertRow();
    const td = tr.insertCell(); td.innerHTML = `${L.name.length > 22 ? short(L.name) : L.name} <small>${L.units}</small>`; td.title = L.name;
    tr.insertCell().innerHTML = `<span class="seg" data-k="${L.key}">${['off', 'macro', 'micro'].map(s => `<button data-s="${s}" class="${s === step[L.key] ? 'on' : ''}">${s}</button>`).join('')}</span>`;
  });
  tb.querySelectorAll('.seg button').forEach(b => b.onclick = () => {
    step[b.parentNode.dataset.k] = b.dataset.s;
    b.parentNode.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  });
  const s1 = $('k1'), s2 = $('k2');
  s1.add(new Option('auto (silhouette)', 'auto')); s2.add(new Option('auto (silhouette)', 'auto'));
  for (let k = 2; k <= 8; k++) s1.add(new Option(k, k)); for (let k = 1; k <= 5; k++) s2.add(new Option(k, k));
  s1.value = 3; s2.value = 2;
  $('map').style.aspectRatio = `${META.cols} / ${META.rows * META.aspect}`;
  $('cv').width = META.cols; $('cv').height = META.rows;
  $('ov').setAttribute('viewBox', `0 0 ${META.cols} ${META.rows}`);
  $('ov').innerHTML = `<path d="${META.counties.join('')}" fill="none" stroke="#fff" stroke-width="0.7" vector-effect="non-scaling-stroke" opacity="0.85"/>`;
  $('cty').onchange = e => { $('ov').style.display = e.target.checked ? '' : 'none'; };
  $('cv').addEventListener('mousemove', readout);
  $('cv').addEventListener('mouseleave', () => $('tip').hidden = true);
  addEventListener('scroll', () => $('tip').hidden = true, { passive: true });
  $('go').onclick = () => { const b = $('go'); b.textContent = 'Working…'; b.disabled = true; setTimeout(() => { try { run(); } finally { b.textContent = 'Create zones'; b.disabled = false; } }, 30); };
  $('dl-csv').onclick = downloadCSV; $('dl-tif').onclick = () => LAB && save(geotiff(LAB.map((v, i) => kept(i) ? v : 0), META.cols, META.rows, META.transform), 'kansas_agrozones.tif');
  document.querySelectorAll('[data-open]').forEach(b => b.onclick = () => { document.querySelectorAll('dialog[open]').forEach(d => d.close()); $(b.dataset.open).showModal(); });
  document.querySelectorAll('dialog').forEach(d => { d.querySelector('.hd button').onclick = () => d.close(); d.addEventListener('click', e => { if (e.target === d) d.close(); }); });
  layerInfo(); corrTable(); $('built').textContent = `Layers built ${META.built}.`;
  maskSetup();
  run();
}

const val = (j, i) => META.layers[j].lo + RAW[j * N + i] / 254 * (META.layers[j].hi - META.layers[j].lo);
const num = v => Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) < 5 ? v.toFixed(2) : v.toFixed(1);
const short = n => { const s = n.replace('Plant available water capacity', 'PAWC').replace('Atmospheric water deficit', 'Water deficit').replace('Annual ', '').replace('Growing degree days', 'GDD').replace('Soil organic matter', 'Organic matter'); return s[0].toUpperCase() + s.slice(1); };
const stepLayers = s => META.layers.map((L, j) => step[L.key] === s ? j : -1).filter(j => j >= 0);

// ---------- correlations ----------
const RC = {};
function corr(a, b) {
  const key = Math.min(a, b) + '-' + Math.max(a, b); if (key in RC) return RC[key];
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0; const n = VALID.length;
  for (const i of VALID) { const x = RAW[a * N + i], y = RAW[b * N + i]; sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y; }
  return RC[key] = (sab / n - sa * sb / n / n) / Math.sqrt((saa / n - (sa / n) ** 2) * (sbb / n - (sb / n) ** 2));
}
function corrTable() {
  const J = META.layers.length, bg = r => { const a = Math.abs(r) ** 1.5 * 0.55; return r > 0 ? `rgba(44,127,184,${a})` : `rgba(200,120,58,${a})`; };
  let h = `<tr><th></th>${META.layers.map(L => `<th>${short(L.name)}</th>`).join('')}</tr>`;
  for (let a = 0; a < J; a++) {
    h += `<tr><th>${short(META.layers[a].name)}</th>`;
    for (let b = 0; b < J; b++) { const r = a === b ? 1 : corr(a, b); h += `<td style="background:${a === b ? '#f6f7f9' : bg(r)}">${a === b ? '' : r.toFixed(2)}</td>`; }
    h += '</tr>';
  }
  $('corr').innerHTML = h;
}
function layerInfo() {
  let h = '<tr><th>Layer</th><th>Represents</th><th>Units</th><th>Kansas range<br>min · median · max</th><th>Definition</th><th>Source</th></tr>';
  for (const L of META.layers) h += `<tr><td><b>${L.name}</b></td><td>${L.role}</td><td>${L.units}</td><td style="white-space:nowrap">${num(L.min)} · ${num(L.median)} · ${num(L.max)}</td><td>${L.desc}</td><td>${L.data}</td></tr>`;
  $('layer-info').innerHTML = h;
}

// ---------- clustering ----------
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// z-scores of one step's layers over the whole state (row-major, pixels x layers)
function stepScores(js) {
  const n = VALID.length, d = js.length, Z = new Float32Array(n * d);
  js.forEach((j, c) => {
    let s = 0, s2 = 0;
    for (let p = 0; p < n; p++) { const v = val(j, VALID[p]); Z[p * d + c] = v; s += v; s2 += v * v; }
    const m = s / n, sd = Math.sqrt(Math.max(s2 / n - m * m, 1e-12));
    for (let p = 0; p < n; p++) Z[p * d + c] = (Z[p * d + c] - m) / sd;
  });
  return { F: Z, d };
}
function rows(F, d, idx) { const out = new Float32Array(idx.length * d); idx.forEach((p, t) => out.set(F.subarray(p * d, p * d + d), t * d)); return out; }

// k-means++ with Lloyd iterations; best of three starts. Returns labels and centres.
function kmeans(F, n, d, k, seed) {
  if (k <= 1 || n <= k) return { lab: new Uint8Array(n), C: null };
  let best = null, bestI = Infinity;
  for (let start = 0; start < 3; start++) {
    const r = rng(seed + 101 * start), C = new Float32Array(k * d), D = new Float32Array(n).fill(Infinity);
    const c0 = Math.floor(r() * n); for (let q = 0; q < d; q++) C[q] = F[c0 * d + q];
    for (let c = 1; c < k; c++) {
      let tot = 0;
      for (let p = 0; p < n; p++) { let s = 0; for (let q = 0; q < d; q++) { const e = F[p * d + q] - C[(c - 1) * d + q]; s += e * e; } if (s < D[p]) D[p] = s; tot += D[p]; }
      let t = r() * tot, p = 0; while (p < n - 1 && (t -= D[p]) > 0) p++;
      for (let q = 0; q < d; q++) C[c * d + q] = F[p * d + q];
    }
    const lab = new Uint8Array(n); let inertia = 0;
    for (let it = 0; it < 60; it++) {
      let moved = 0; inertia = 0;
      for (let p = 0; p < n; p++) {
        let bi = 0, bs = Infinity;
        for (let c = 0; c < k; c++) { let s = 0; for (let q = 0; q < d; q++) { const e = F[p * d + q] - C[c * d + q]; s += e * e; } if (s < bs) { bs = s; bi = c; } }
        if (lab[p] !== bi) { lab[p] = bi; moved++; } inertia += bs;
      }
      const S = new Float64Array(k * d), cnt = new Float64Array(k);
      for (let p = 0; p < n; p++) { cnt[lab[p]]++; for (let q = 0; q < d; q++) S[lab[p] * d + q] += F[p * d + q]; }
      for (let c = 0; c < k; c++) if (cnt[c]) for (let q = 0; q < d; q++) C[c * d + q] = S[c * d + q] / cnt[c];
      if (moved < n * 1e-4) break;
    }
    if (inertia < bestI) { bestI = inertia; best = { lab, C }; }
  }
  return best;
}


// mean silhouette of labelled points
function silhouette(F, n, d, lab, k) {
  const cnt = new Float64Array(k); for (let p = 0; p < n; p++) cnt[lab[p]]++;
  let tot = 0, used = 0; const sum = new Float64Array(k);
  for (let p = 0; p < n; p++) {
    sum.fill(0);
    for (let q = 0; q < n; q++) { if (q === p) continue; let s = 0; for (let c = 0; c < d; c++) { const e = F[p * d + c] - F[q * d + c]; s += e * e; } sum[lab[q]] += Math.sqrt(s); }
    const own = lab[p]; if (cnt[own] < 2) continue;
    const a = sum[own] / (cnt[own] - 1); let b = Infinity;
    for (let c = 0; c < k; c++) if (c !== own && cnt[c]) b = Math.min(b, sum[c] / cnt[c]);
    tot += (b - a) / Math.max(a, b); used++;
  }
  return used ? tot / used : 0;
}
// silhouette for each candidate k: cluster a 20,000-pixel sample, score 3,000 of them
function silCurve(F, d, idx, ks, seed) {
  const r = rng(seed), s = Array.from(idx); for (let i = s.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [s[i], s[j]] = [s[j], s[i]]; }
  const fit = s.slice(0, Math.min(20000, s.length)), Ff = rows(F, d, fit), out = {};
  for (const k of ks) {
    if (fit.length <= k) continue;
    const lab = kmeans(Ff, fit.length, d, k, seed + k).lab, m = Math.min(3000, fit.length);
    out[k] = silhouette(Ff.subarray(0, m * d), m, d, lab.subarray(0, m), k);
  }
  return out;
}
const argmax = o => +Object.keys(o).reduce((a, b) => o[b] > o[a] ? b : a);

// renumber clusters by the mean of one layer (lowest first)
function order(lab, k, idx, j) {
  const s = new Float64Array(k), c = new Float64Array(k);
  for (let n = 0; n < idx.length; n++) { s[lab[n]] += val(j, VALID[idx[n]]); c[lab[n]]++; }
  const o = [...Array(k).keys()].sort((a, b) => s[a] / (c[a] || 1) - s[b] / (c[b] || 1)), map = new Uint8Array(k);
  o.forEach((old, nw) => map[old] = nw);
  for (let n = 0; n < lab.length; n++) lab[n] = map[lab[n]];
}

// silhouette by number of zones: small bar chart (macro) and table (micro, one row per macrozone)
function silChart(c, used) {
  const ks = Object.keys(c).map(Number), W = 280, H = 96, top = Math.max(0.6, Math.ceil(Math.max(...Object.values(c)) * 10) / 10);
  const bw = W / ks.length, best = argmax(c), y = v => 14 + (H - 34) * (1 - Math.max(v, 0) / top);
  let g = `<line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" stroke="#d1d5db"/>`;
  ks.forEach((k, i) => {
    const x = i * bw + bw * 0.18, w = bw * 0.64, v = c[k];
    g += `<rect x="${x}" y="${y(v)}" width="${w}" height="${y(0) - y(v)}" rx="2" fill="${k === used ? '#1f2a37' : '#cbd2da'}"/>`;
    g += `<text x="${x + w / 2}" y="${y(v) - 3}" text-anchor="middle" font-size="10" fill="#1f2a37" font-weight="${k === best ? 700 : 400}">${v.toFixed(2)}</text>`;
    g += `<text x="${x + w / 2}" y="${H - 6}" text-anchor="middle" font-size="10" fill="#6b7280">${k}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Silhouette score by number of macrozones">${g}</svg>`;
}
function silTable(curves) {
  const ks = [2, 3, 4, 5];
  let h = `<table class="sil"><tr><th>Macrozone</th>${ks.map(k => `<th>${k}</th>`).join('')}</tr>`;
  curves.forEach((c, m) => {
    if (!c) return;
    const best = argmax(c);
    h += `<tr><td><span class="sw" style="background:${colour((m + 1) * 10 + Math.ceil(K2m[m] / 2))}"></span>${m + 1}</td>` +
      ks.map(k => `<td class="${k === K2m[m] ? 'used' : ''} ${k === best ? 'best' : ''}">${c[k] == null ? '' : c[k].toFixed(2)}</td>`).join('') + '</tr>';
  });
  return h + '</table>';
}

function run() {
  const mj = stepLayers('macro'), uj = stepLayers('micro');
  if (!mj.length) { $('status').innerHTML = '<span class="warn">Choose at least one macro layer.</span>'; return; }
  const k1s = $('k1').value, k2s = $('k2').value, all = Uint32Array.from(VALID.keys());
  const Sm = stepScores(mj), curve = silCurve(Sm.F, Sm.d, all, [2, 3, 4, 5, 6, 7, 8], 3);
  K1 = k1s === 'auto' ? argmax(curve) : +k1s;
  MAC = kmeans(Sm.F, all.length, Sm.d, K1, 7).lab; order(MAC, K1, all, mj[0]);
  MIC = new Uint8Array(VALID.length); K2m = Array(K1).fill(1);
  const mcurves = [];
  if (uj.length) {
    const Su = stepScores(uj);
    for (let m = 0; m < K1; m++) {
      const idx = all.filter(n => MAC[n] === m); if (!idx.length) continue;
      mcurves[m] = silCurve(Su.F, Su.d, idx, [2, 3, 4, 5], 13 + m);
      K2m[m] = k2s === 'auto' ? argmax(mcurves[m]) : +k2s;
      if (K2m[m] === 1) continue;
      const lab = kmeans(rows(Su.F, Su.d, idx), idx.length, Su.d, K2m[m], 11 + m).lab; order(lab, K2m[m], idx, uj[0]);
      idx.forEach((n, t) => MIC[n] = lab[t]);
    }
  }
  $('status').innerHTML = `<h5>Silhouette, macrozones</h5>${silChart(curve, K1)}` +
    (uj.length ? `<h5>Silhouette, microzones</h5>${silTable(mcurves)}` : '<h5>No micro layers</h5>One pooled clustering of the macro layers.') +
    '<ul class="key"><li>Higher: better-separated zones</li><li>Dark bar or shaded cell: number used</li><li>Bold: highest score</li></ul>';
  smooth(+$('smooth').value); cropMask();
}

// majority filter on the zone codes
function smooth(r) {
  LAB = new Uint8Array(N); VALID.forEach((i, n) => LAB[i] = (MAC[n] + 1) * 10 + MIC[n] + 1);
  if (!r) return;
  const W = META.cols, H = META.rows, out = LAB.slice(), cnt = new Uint16Array(100);
  for (const i of VALID) {
    const y = Math.floor(i / W), x = i % W, seen = [];
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const yy = y + dy, xx = x + dx; if (yy < 0 || yy >= H || xx < 0 || xx >= W) continue;
      const v = LAB[yy * W + xx]; if (!v) continue; if (!cnt[v]) seen.push(v); cnt[v]++;
    }
    let b = LAB[i], bc = cnt[b]; for (const v of seen) { if (cnt[v] > bc) { b = v; bc = cnt[v]; } cnt[v] = 0; }
    out[i] = b;
  }
  LAB = out;
}

// ---------- masks: crop (by county) and soil texture (by pixel) ----------
const TEXTURES = ['Sand', 'Loamy sand', 'Sandy loam', 'Loam', 'Silt loam', 'Silt', 'Sandy clay loam', 'Clay loam', 'Silty clay loam', 'Sandy clay', 'Silty clay', 'Clay'];
let TEX = null, TXSEL = 0;   // USDA texture class of each pixel (1-12, index into TEXTURES + 1), chosen class (0 = all)
function texClass(s, c) {    // USDA texture triangle from sand and clay (%)
  const t = 100 - s - c;
  if (t + 1.5 * c < 15) return 1;
  if (t + 2 * c < 30) return 2;
  if ((c >= 7 && c < 20 && s > 52) || (c < 7 && t < 50)) return 3;
  if (c >= 7 && c < 27 && t >= 28 && t < 50 && s <= 52) return 4;
  if ((t >= 50 && c >= 12 && c < 27) || (t >= 50 && t < 80 && c < 12)) return 5;
  if (t >= 80 && c < 12) return 6;
  if (c >= 20 && c < 35 && t < 28 && s > 45) return 7;
  if (c >= 27 && c < 40 && s > 20 && s <= 45) return 8;
  if (c >= 27 && c < 40 && s <= 20) return 9;
  if (c >= 35 && s > 45) return 10;
  if (c >= 40 && t >= 40) return 11;
  return 12;
}
function maskSetup() {
  const js = META.layers.findIndex(L => L.key === 'sand'), jc = META.layers.findIndex(L => L.key === 'clay'), area = new Float64Array(13);
  TEX = new Uint8Array(N); VALID.forEach((i, n) => { TEX[i] = texClass(val(js, i), val(jc, i)); area[TEX[i]] += cellArea[n]; });
  [...area.keys()].filter(k => area[k] > 0).sort((a, b) => area[b] - area[a]).forEach(k => $('tex').add(new Option(TEXTURES[k - 1], k)));
  $('tex').onchange = () => { TXSEL = +$('tex').value; draw(); table(); };
  cropSetup();
}
function cropSetup() {
  if (!CROPS) return;
  $('crop-rows').hidden = false;
  CROPS.crops.forEach(c => $('crop').add(new Option(c.name, c.key)));
  CPX = new Float64Array(META.county_names.length + 1); VALID.forEach((i, n) => CPX[CID[i]] += cellArea[n]);
  $('crop').onchange = $('keep').onchange = cropMask;
  $('crop-info-wrap').hidden = false; cropInfo();
}
// rank counties by crop area and keep the largest until together they hold the chosen share of the Kansas total
function cropMask() {
  CROP = (CROPS && CROPS.crops.find(c => c.key === $('crop').value)) || null; KEEP = null;
  $('keep').disabled = !CROP;
  if (CROP) {
    const share = +$('keep').value / 100, tot = CROP.ha.reduce((a, b) => a + b, 0);
    const o = CROP.ha.map((v, c) => c).sort((a, b) => CROP.ha[b] - CROP.ha[a]);
    KEEP = new Uint8Array(CROP.ha.length + 1); let cum = 0, n = 0;
    for (const c of o) { if (cum >= share * tot) break; KEEP[c + 1] = 1; cum += CROP.ha[c]; n++; }
    const names = o.filter(c => KEEP[c + 1]).map(c => META.county_names[c]);
    $('crop-status').innerHTML = `${n} of ${CROP.ha.length} counties kept.<details><summary>Counties kept</summary>${names.join(', ')}</details>`;
  } else $('crop-status').textContent = '';
  draw(); table();
}
const k1 = v => (Math.round(v / 1000) * 1000).toLocaleString('en-US');   // nearest 1,000
function cropInfo() {
  let h = `<tr><th>Crop</th><th>CDL classes</th><th>Kansas area, ha</th><th>Kansas area, acres</th></tr>`;
  for (const c of CROPS.crops) h += `<tr><td><b>${c.name}</b></td><td>${c.classes.join('; ')}</td><td>${k1(c.kansas_ha)}</td><td>${k1(c.kansas_ha * 2.47105)}</td></tr>`;
  $('crop-info').innerHTML = h;
  $('crop-info-src').textContent = `${CROPS.source}, mean of ${CROPS.years[0]}–${CROPS.years[1]}, summed by county. Used by the crop mask.`;
}
const kept = i => (!KEEP || KEEP[CID[i]] === 1) && (!TXSEL || TEX[i] === TXSEL);
const fmtHa = v => v >= 1e6 ? (v / 1e6).toFixed(2) + ' million ha' : Math.round(v).toLocaleString('en-US') + ' ha';

// ---------- drawing ----------
function colour(code) {
  const m = Math.floor(code / 10) - 1, u = code % 10 - 1, k = K2m[m] || 1;
  const l = k > 1 ? 78 - 44 * u / (k - 1) : 55;
  return `hsl(${HUES[m % 8]} ${k > 1 ? 45 + 0.4 * (80 - l) : 55}% ${l}%)`;
}
const ctx1 = document.createElement('canvas').getContext('2d');
function rgb(css) { ctx1.fillStyle = css; ctx1.fillRect(0, 0, 1, 1); return ctx1.getImageData(0, 0, 1, 1).data; }
function draw() {
  const ctx = $('cv').getContext('2d'), img = ctx.createImageData(META.cols, META.rows), cache = {};
  for (const i of VALID) { const v = kept(i) ? LAB[i] : 0, c = cache[v] || (cache[v] = v ? rgb(colour(v)) : [226, 229, 233]); img.data.set([c[0], c[1], c[2], 255], i * 4); }
  ctx.putImageData(img, 0, 0);
}

function table() {
  const z = {}, J = META.layers.length; let tot = 0, ctot = 0;
  VALID.forEach((i, n) => {
    if (!kept(i)) return;
    const code = LAB[i], w = cellArea[n], cw = CROP ? w * CROP.ha[CID[i] - 1] / CPX[CID[i]] : 0;   // crop spread evenly over its county
    tot += w; ctot += cw;
    for (const key of [Math.floor(code / 10) * 10, code]) {
      const s = z[key] || (z[key] = { w: 0, c: 0, v: new Float64Array(J) });
      s.w += w; s.c += cw; for (let j = 0; j < J; j++) s.v[j] += w * val(j, i);
    }
  });
  STATS = Object.keys(z).map(Number).sort((a, b) => a - b).map(c => ({ code: c, macro: c % 10 === 0, area: z[c].w / tot * 100, crop: CROP ? z[c].c / ctot * 100 : null, mean: Array.from(z[c].v, v => v / z[c].w) }));
  const pooled = K2m.every(k => k === 1);
  let h = `<tr><th>Zone</th><th>Area %</th>${CROP ? `<th class="sel">${CROP.name}<br>%</th>` : ''}${META.layers.map(L => `<th class="${step[L.key] !== 'off' ? 'sel' : ''}">${short(L.name)}<br>${L.units}</th>`).join('')}</tr>`;
  for (const s of STATS) {
    if (s.macro && pooled) continue;
    const m = Math.floor(s.code / 10), name = s.macro ? `Macrozone ${m}` : pooled ? `Zone ${m}` : `${m}.${s.code % 10}`;
    const sw = s.macro ? colour(s.code + Math.ceil((K2m[m - 1] || 1) / 2)) : colour(s.code);
    h += `<tr class="${s.macro ? 'macro' : ''}"><td><span class="sw" style="background:${sw}"></span>${name}</td><td>${s.area.toFixed(1)}</td>${CROP ? `<td>${s.crop.toFixed(1)}</td>` : ''}${s.mean.map(v => `<td>${num(v)}</td>`).join('')}</tr>`;
  }
  $('zones').innerHTML = h;
}

// hover card next to the pointer
function readout(e) {
  const b = e.target.getBoundingClientRect(), x = Math.floor((e.clientX - b.left) / b.width * META.cols), y = Math.floor((e.clientY - b.top) / b.height * META.rows), i = y * META.cols + x, tip = $('tip');
  if (x < 0 || y < 0 || x >= META.cols || y >= META.rows || RAW[i] === 255 || !LAB) { tip.hidden = true; return; }
  const code = LAB[i], m = Math.floor(code / 10), pooled = K2m.every(k => k === 1), on = kept(i);
  const lon = META.transform[2] + (x + 0.5) * META.transform[0], lat = META.transform[5] + (y + 0.5) * META.transform[4];
  tip.innerHTML = `<div class="t1"><span class="sw" style="background:${on ? colour(code) : '#e2e5e9'}"></span><b>Zone ${m}${pooled ? '' : '.' + code % 10}</b><span>${META.county_names[CID[i] - 1]} County</span></div>` +
    `<div class="t2">${lat.toFixed(3)}°N, ${(-lon).toFixed(3)}°W${on ? '' : ' · masked'}</div>` +
    `<div class="t3">Soil texture: ${TEXTURES[TEX[i] - 1].toLowerCase()}</div>` +
    (CROP ? `<div class="t3">${CROP.name}: ${fmtHa(CROP.ha[CID[i] - 1])} a year</div>` : '') +
    `<table>${META.layers.map((L, j) => `<tr class="${step[L.key] === 'off' ? 'off' : ''}"><td>${short(L.name)}</td><td>${num(val(j, i))}</td><td>${L.units}</td></tr>`).join('')}</table>`;
  tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight, gap = 16;
  tip.style.left = (e.clientX + gap + w > innerWidth ? e.clientX - gap - w : e.clientX + gap) + 'px';
  tip.style.top = Math.max(4, Math.min(e.clientY + gap, innerHeight - h - 4)) + 'px';
}

// ---------- downloads ----------
function save(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
function settings() {
  return META.layers.filter(L => step[L.key] !== 'off').map(L => `${L.key}:${step[L.key]}`).join(' ') + ` k1:${K1} k2:${K2m.join('/')} smooth:${$('smooth').value}` +
    (CROP ? ` crop:${CROP.key} keep:${$('keep').value}% (CDL ${CROPS.years[0]}-${CROPS.years[1]})` : '') + (TXSEL ? ` texture:${TEXTURES[TXSEL - 1].toLowerCase()}` : '');
}
function downloadCSV() {
  const out = [['zone', 'level', 'area_pct', ...(CROP ? [`${CROP.key}_pct`] : []), ...META.layers.map(L => `${L.key}_${L.units.replace(/[^a-zA-Z%]/g, '')}`)].join(',')];
  for (const s of STATS) out.push([s.macro ? s.code / 10 : `${Math.floor(s.code / 10)}.${s.code % 10}`, s.macro ? 'macro' : 'micro', s.area.toFixed(2), ...(CROP ? [s.crop.toFixed(2)] : []), ...s.mean.map(v => v.toFixed(3))].join(','));
  out.push(`# settings: ${settings()}`);
  if (KEEP) out.push(`# counties kept: ${META.county_names.filter((nm, c) => KEEP[c + 1]).join('; ')}`);
  save(new Blob([out.join('\n')], { type: 'text/csv' }), 'kansas_agrozones.csv');
}

// minimal single-band uint8 GeoTIFF (one strip, uncompressed, EPSG:4326, nodata 0)
function geotiff(data, W, H, tr) {
  const tags = [[256, 3, 1, W], [257, 3, 1, H], [258, 3, 1, 8], [259, 3, 1, 1], [262, 3, 1, 1], [273, 4, 1, 0], [277, 3, 1, 1], [278, 3, 1, H],
                [279, 4, 1, W * H], [284, 3, 1, 1], [339, 3, 1, 1], [33550, 12, 3, [tr[0], -tr[4], 0]], [33922, 12, 6, [0, 0, 0, tr[2], tr[5], 0]],
                [34735, 3, 16, [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326]], [42113, 2, 2, '0\0']];
  const size = { 2: 1, 3: 2, 4: 4, 12: 8 }, ifd = 8, ifdLen = 2 + tags.length * 12 + 4;
  let extra = ifd + ifdLen; const ext = [];
  for (const t of tags) { const n = size[t[1]] * t[2]; if (n > 4) { ext.push([t, extra]); extra += n + (n % 2); } }
  const dataOff = extra, buf = new ArrayBuffer(dataOff + W * H), dv = new DataView(buf);
  dv.setUint16(0, 0x4949); dv.setUint16(2, 42, true); dv.setUint32(4, ifd, true); dv.setUint16(ifd, tags.length, true);
  const put = (t, off) => {
    const v = Array.isArray(t[3]) ? t[3] : typeof t[3] === 'string' ? [...t[3]].map(c => c.charCodeAt(0)) : [t[3]];
    v.forEach((x, k) => { if (t[1] === 2) dv.setUint8(off + k, x); else if (t[1] === 3) dv.setUint16(off + 2 * k, x, true); else if (t[1] === 4) dv.setUint32(off + 4 * k, x, true); else dv.setFloat64(off + 8 * k, x, true); });
  };
  tags.forEach((t, k) => {
    const e = ifd + 2 + k * 12; dv.setUint16(e, t[0], true); dv.setUint16(e + 2, t[1], true); dv.setUint32(e + 4, t[2], true);
    if (t[0] === 273) t[3] = dataOff;
    const x = ext.find(q => q[0] === t); if (x) { dv.setUint32(e + 8, x[1], true); put(t, x[1]); } else put(t, e + 8);
  });
  dv.setUint32(ifd + 2 + tags.length * 12, 0, true);
  new Uint8Array(buf, dataOff).set(data);
  return new Blob([buf], { type: 'image/tiff' });
}
