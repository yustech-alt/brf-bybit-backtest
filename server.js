Today 3:37 PM

"use strict";
// FUNDING CARRY BACKTEST (standalone, no packages, Node 18+)
//
// Position: $1 of spot bought, $1 of the same coin's USDT perp sold short.
// Price moves cancel out. You earn the funding rate while it is positive and pay it
// while it is negative. Nothing here predicts price.
//
// P&L per $1 of notional = spot move - perp move + funding - fees and slippage.
// Basis (perp minus spot) can move against you between entry and exit. It is
// included because both legs are marked hour by hour from real candles.
// Capital reserved per slot = $1 spot + $1/leverage of perp margin.
//
// Two studies share one data download:
// 1. Entry/exit carry (runFundingCarry): trailing-funding thresholds, per coin.
// 2. Ranked carry (runFundingRank): monthly ranking of coins by trailing funding,
// plus a persistence test and per-coin funding diagnostics in the same report.
//
// Accounting notes (fixed in this version):
// - The final partial week is folded into the last full week, so the exit cost of a
// position closed at the end of the data is counted in the measured series.
// - The ranked study indexes weeks from its first ranking date, so the entry cost
// and first days of funding are inside the measured series.
// - 95% ranges use a t critical value instead of 1.96 (about 20 weekly points).
//
// CLI: node funding-carry.js --days 365 --top 60 [--mode rank] [--lev 3] [--costs 1]
// Render: require("./funding-carry").mountRoutes(app, { bybit, log, ledger })
// GET /carry/start?days=365&top=60 GET /carry/report
// GET /carry/rank/start?days=365&top=60 GET /carry/rank/report

const fs = require("fs");
const path = require("path");

const HOUR = 3600 * 1000, DAY = 24 * HOUR, WEEK = 7 * DAY;
const BASE = (process.env.BYBIT_BASE || "https://api.bybit.com").replace(/\/+$/, "");
const CACHE_DIR = process.env.FC_CACHE_DIR || "./fc-cache";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── DATA ACCESS ───────────────────────────────────────────────────────────
async function defaultFetchJson(pathname, params) {
const qs = new URLSearchParams(params).toString();
const res = await fetch(`${BASE}${pathname}${qs ? "?" + qs : ""}`, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
const text = await res.text();
let data;
try { data = JSON.parse(text); } catch (e) { throw new Error(`non-JSON response (HTTP ${res.status}): ${text.slice(0, 120)}`); }
if (data.retCode !== 0) throw new Error(`Bybit ${data.retCode}: ${data.retMsg}`);
return data.result;
}
function throttled(fn, gapMs) {
let last = 0;
return async (p, params) => {
let err;
for (let a = 0; a < 5; a++) {
const wait = last + gapMs - Date.now();
if (wait > 0) await sleep(wait);
last = Date.now();
try { return await fn(p, params); }
catch (e) { err = e; await sleep(1000 * (a + 1) * (/10006|too many|rate/i.test(e.message) ? 3 : 1)); }
}
throw err;
};
}
const slipPerSide = (turnover) => (turnover >= 1e8 ? 0.0002 : turnover >= 2e7 ? 0.0004 : 0.0008);
function dedupeSort(arr, key) { const m = new Map(); for (const x of arr) m.set(key(x), x); return [...m.values()].sort((a, b) => key(a) - key(b)); }

// Bybit returns newest first. Page backwards by moving `end` to just before the oldest row.
// Kline uses start/end. Funding history uses startTime/endTime. Sending the wrong pair
// makes Bybit ignore the range and return the newest page again.
async function pageBack({ fetchJson, pathname, params, startMs, endMs, limit, tsOf, startKey = "startTime", endKey = "endTime" }) {
const out = [];
let end = endMs, prevOldest = Infinity;
for (let guard = 0; guard < 200; guard++) {
const res = await fetchJson(pathname, { ...params, [startKey]: startMs, [endKey]: end, limit });
const list = res.list || [];
if (!list.length) break;
out.push(...list);
const oldest = Math.min(...list.map(tsOf));
if (oldest <= startMs || list.length < limit) break;
if (oldest >= prevOldest) break; // no older rows came back, stop instead of repeating the same page
prevOldest = oldest;
end = oldest - 1;
}
return out;
}

async function loadCoin(sym, spotSym, days, ctx) {
const { fetchJson, useCache } = ctx;
const cacheFile = path.join(CACHE_DIR, `${sym}_${days}.json`);
if (useCache) {
try {
if (Date.now() - fs.statSync(cacheFile).mtimeMs < DAY) return JSON.parse(fs.readFileSync(cacheFile, "utf8"));
} catch (e) { /* no cache */ }
}
const endMs = Date.now(), startMs = endMs - days * DAY;
const kl = async (category, symbol) => {
const rows = await pageBack({ fetchJson, pathname: "/v5/market/kline", params: { category, symbol, interval: "60" }, startMs, endMs, limit: 1000, tsOf: (r) => parseInt(r[0]), startKey: "start", endKey: "end" });
return dedupeSort(rows.map((r) => ({ t: parseInt(r[0]), o: +r[1], h: +r[2], l: +r[3], c: +r[4] })), (x) => x.t);
};
const perp = await kl("linear", sym);
const spot = await kl("spot", spotSym);
const f = await pageBack({ fetchJson, pathname: "/v5/market/funding/history", params: { category: "linear", symbol: sym }, startMs, endMs, limit: 200, tsOf: (r) => parseInt(r.fundingRateTimestamp) });
const funding = dedupeSort(f.map((r) => ({ t: parseInt(r.fundingRateTimestamp), rate: +r.fundingRate })), (x) => x.t);
const data = { sym, spotSym, perp, spot, funding };
if (useCache) { try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(data)); } catch (e) { /* optional */ } }
return data;
}

async function pickUniverse(top, fetchJson) {
const lin = await fetchJson("/v5/market/tickers", { category: "linear" });
const spotRes = await fetchJson("/v5/market/tickers", { category: "spot" });
const spotSet = new Set((spotRes.list || []).map((t) => t.symbol));
const out = [];
for (const t of (lin.list || [])
.filter((x) => x.symbol.endsWith("USDT"))
.map((x) => ({ symbol: x.symbol, turnover: +x.turnover24h }))
.filter((x) => x.turnover > 20e6)
.sort((a, b) => b.turnover - a.turnover)) {
// 1000PEPEUSDT on the perp side is PEPEUSDT on spot. Returns are compared, so the scale does not matter.
const spotSym = spotSet.has(t.symbol) ? t.symbol : t.symbol.replace(/^10{3,}/, "");
if (!spotSet.has(spotSym)) continue;
out.push({ symbol: t.symbol, spotSym, turnover: t.turnover });
if (out.length >= top) break;
}
return out;
}

// ─── PREPARE ───────────────────────────────────────────────────────────────
const KS = [3, 9, 21];

function prepare(d, slip) {
const sm = new Map(d.spot.map((c) => [c.t, c]));
const a = { sym: d.sym, slip, t: [], po: [], ph: [], pc: [], so: [], sc: [] };
for (const p of d.perp) {
const s = sm.get(p.t);
if (!s) continue;
a.t.push(p.t); a.po.push(p.o); a.ph.push(p.h); a.pc.push(p.c); a.so.push(s.o); a.sc.push(s.c);
}
a.idx = new Map(a.t.map((t, i) => [t, i]));
// funding, with an hourly-normalized rate so 8h, 4h and 1h coins compare
const fs = { ts: [], rate: [], hr: [] };
d.funding.forEach((f, i) => {
fs.ts.push(f.t); fs.rate.push(f.rate);
const gapH = i === 0 ? 8 : Math.max(1, (f.t - d.funding[i - 1].t) / HOUR);
fs.hr.push(f.rate / gapH);
});
a.fs = fs;
a.tr = {};
for (const K of KS) {
a.tr[K] = fs.hr.map((_, k) => {
if (k - K + 1 < 1) return null;
let s = 0;
for (let j = k - K + 1; j <= k; j++) s += fs.hr[j];
return (s / K) * 24 * 365; // annualized, simple
});
}
a.fAt = new Map(); // candle index -> funding index
fs.ts.forEach((t, k) => { const ci = a.idx.get(t); if (ci !== undefined) a.fAt.set(ci, k); });
return a;
}

// Weekly bucket for candle i. The last (partial) week is folded into the last full week so
// that a terminal exit cost and the final days of funding stay inside the measured series.
function weekIndex(weekly, ts, t0) {
return Math.min(Math.max(0, weekly.length - 2), Math.floor((ts - t0) / WEEK));
}

// ─── SIMULATION ────────────────────────────────────────────────────────────
function simCoin(a, v, P, weekly, t0) {
const n = a.t.length, fs = a.fs;
const out = { trades: 0, forced: 0, hoursIn: 0, holdHours: [] };
const cost = (P.feeSpot + P.feePerp + 2 * a.slip) * P.costMult; // per side, per $1 of notional
const trig = 1 + 0.8 / P.lev; // perp price at which the short is close to liquidation
const add = (i, val) => { weekly[weekIndex(weekly, a.t[i], t0)] += val; };
let k = 0;
while (k < fs.ts.length) {
const ci = a.idx.get(fs.ts[k]);
if (ci === undefined) { k++; continue; }
const e = ci + 1;
if (e >= n - 1) break;
const tr = a.tr[v.K || 3][k];
const enter = v.hold ? true : tr !== null && tr >= v.E;
if (!enter) { k++; continue; }

const spotE = a.so[e], perpE = a.po[e];
add(e, -cost);
let x = e;
for (let i = e; i < n; i++) {
  x = i;
  const ps = i === e ? spotE : a.sc[i - 1];
  const pp = i === e ? perpE : a.pc[i - 1];
  let pnl = (a.sc[i] - ps) / spotE - (a.pc[i] - pp) / perpE;
  const kk = i > e ? a.fAt.get(i) : undefined;
  if (kk !== undefined) pnl += (fs.rate[kk] \* a.po[i]) / perpE; // shorts receive positive funding
  let exit = false;
  if (a.ph[i] >= perpE \* trig) { exit = true; out.forced++; }
  else if (!v.hold && kk !== undefined) {
    const t2 = a.tr[v.K][kk];
    if (t2 !== null && t2 < v.X) exit = true;
  }
  if (i === n - 1) exit = true;
  if (exit) pnl -= cost;
  add(i, pnl);
  if (exit) break;
}
out.trades++; out.hoursIn += x - e + 1; out.holdHours.push(x - e + 1);
while (k < fs.ts.length && fs.ts[k] <= a.t[x]) k++;

}
return out;
}

// ─── STATS ─────────────────────────────────────────────────────────────────
// Two-sided 95% t critical values for df 1..30. Beyond that, about 2.0.
const T95 = [NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];
const tCrit = (df) => (df < 1 ? NaN : df <= 30 ? T95[df] : 2.0);
const mean = (arr) => arr.reduce((s, x) => s + x, 0) / arr.length;
const median = (arr) => { const s = [...arr].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function seriesStats(arr) {
const n = arr.length;
if (n < 4) return { n, annual: null, lo: null, hi: null };
const mu = mean(arr);
const sd = Math.sqrt(arr.reduce((s, x) => s + (x - mu) ** 2, 0) / (n - 1));
const se = (sd / Math.sqrt(n)) * tCrit(n - 1);
return { n, annual: mu * 52, lo: (mu - se) * 52, hi: (mu + se) * 52 };
}
// mean with a t-based 95% range, for plain (non-annualized) values
function meanStats(arr) {
const n = arr.length;
if (n < 3) return { n, mean: n ? mean(arr) : null, lo: null, hi: null };
const mu = mean(arr);
const sd = Math.sqrt(arr.reduce((s, x) => s + (x - mu) ** 2, 0) / (n - 1));
const h = (sd / Math.sqrt(n)) * tCrit(n - 1);
return { n, mean: mu, lo: mu - h, hi: mu + h };
}
function maxDrawdown(arr) {
let cum = 0, peak = 0, dd = 0;
for (const x of arr) { cum += x; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
return dd;
}
function rankOf(v) { // average ranks for ties
const idx = v.map((_, i) => i).sort((a, b) => v[a] - v[b]);
const r = new Array(v.length);
for (let i = 0; i < idx.length;) {
let j = i;
while (j + 1 < idx.length && v[idx[j + 1]] === v[idx[i]]) j++;
const avg = (i + j) / 2 + 1;
for (let k = i; k <= j; k++) r[idx[k]] = avg;
i = j + 1;
}
return r;
}
function spearman(x, y) {
const n = x.length;
if (n < 3) return null;
const rx = rankOf(x), ry = rankOf(y), mx = mean(rx), my = mean(ry);
let sxy = 0, sxx = 0, syy = 0;
for (let i = 0; i < n; i++) { const dx = rx[i] - mx, dy = ry[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

function buildVariants() {
const v = [{ id: "hold_all", hold: true, K: 3 }];
for (const K of KS) for (const E of [0.10, 0.20, 0.40]) for (const xm of ["zero", "half"])
v.push({ id: `carry_k${K}_in${Math.round(E * 100)}_out${xm}`, K, E, X: xm === "zero" ? 0 : E / 2 });
return v;
}

function usableCoins(datasets, P) {
const coins = datasets.map((x) => x.a || prepare(x.d, x.slip)).filter((a) => a.t.length >= 0.9 * P.days * 24 && a.fs.ts.length >= 60);
if (!coins.length) throw new Error(`no coin has enough spot and perp history (need ${Math.round(0.9 * P.days * 24)} aligned hourly candles and 60 funding records)`);
return coins;
}

function runCarry(datasets, P) {
const coins = usableCoins(datasets, P);
const t0 = Math.min(...coins.map((a) => a.t[0]));
const tEnd = Math.max(...coins.map((a) => a.t[a.t.length - 1]));
const W = Math.floor((tEnd - t0) / WEEK) + 1;
const splitW = Math.floor(0.6 * W);
const capital = coins.length * (1 + 1 / P.lev);
const rows = [];
for (const v of buildVariants()) {
const weekly = new Array(W).fill(0);
let trades = 0, forced = 0, hoursIn = 0, holds = [];
for (const a of coins) {
const o = simCoin(a, v, P, weekly, t0);
trades += o.trades; forced += o.forced; hoursIn += o.hoursIn; holds = holds.concat(o.holdHours);
}
const ret = weekly.map((x) => x / capital);
const totalCoinHours = coins.reduce((s, a) => s + a.t.length, 0);
const deployed = hoursIn / totalCoinHours;
// the last bucket is empty because the partial week is folded into the one before it
const older = seriesStats(ret.slice(0, splitW)), newer = seriesStats(ret.slice(splitW, W - 1));
rows.push({
id: v.id, hold: !!v.hold, older, newer, trades, forced, deployed,
avgHoldDays: holds.length ? holds.reduce((s, x) => s + x, 0) / holds.length / 24 : 0,
worstWeek: Math.min(...ret.slice(0, W - 1)), maxDD: maxDrawdown(ret.slice(0, W - 1)),
});
}
const ranked = rows.filter((r) => !r.hold && r.trades >= 20 && r.older.annual !== null).sort((a, b) => b.older.annual - a.older.annual);
const top1 = ranked[0] || null;
const passOf = (r) => !!(r && r.older.annual > 0 && r.newer.lo !== null && r.newer.lo > 0);
const holdRow = rows.find((r) => r.hold);
return { rows, ranked, top1, holdRow, pass: passOf(top1), holdPass: passOf(holdRow), meta: { coins: coins.length, t0, tEnd, splitT: t0 + splitW * WEEK, weeks: W, P } };
}

// ─── REPORT ────────────────────────────────────────────────────────────────
const pl = (x) => (100 * x).toFixed(1) + "%";
const pc1 = (x) => (x == null ? " n/a" : (x >= 0 ? "+" : "") + (100 * x).toFixed(1) + "%");
const dayStr = (t) => new Date(t).toISOString().slice(0, 10);

function formatReport(res) {
const { meta: m } = res, P = m.P, L = [];
L.push(`Funding carry backtest: ${P.days} days, ${m.coins} coins with both spot and perp, 1h candles`);
L.push(`Position: $1 spot long, $1 perp short per coin. Perp margin at ${P.lev}x, so capital reserved per coin is $${(1 + 1 / P.lev).toFixed(2)}.`);
L.push(`Costs per side: spot fee ${(P.feeSpot * 100).toFixed(2)}% + perp fee ${(P.feePerp * 100).toFixed(3)}% + slippage on both legs (0.02% to 0.08% by liquidity), x${P.costMult}`);
L.push(`Older: ${dayStr(m.t0)} to ${dayStr(m.splitT)}. Newer: ${dayStr(m.splitT)} to ${dayStr(m.tEnd)}. Weekly returns, all coins pooled, idle capital counted.`);
L.push("Returns are annualized on capital reserved for every coin, even while a coin sits out. Terminal exit costs are counted (last partial week folded into the last full week).");
L.push("");
const h = res.holdRow;
L.push("Baseline: hold every coin the whole period");
L.push(` older ${pc1(h.older.annual)} | newer ${pc1(h.newer.annual)} [${pc1(h.newer.lo)}, ${pc1(h.newer.hi)}] | forced exits ${h.forced} | worst week ${pl(h.worstWeek)} | max drawdown ${pl(h.maxDD)}`);
L.push("");
L.push("Top 10 entry/exit variants by older data");
L.push("variant | older/yr | newer/yr 95% range | trades hold(d) deployed forced");
for (const r of res.ranked.slice(0, 10)) {
L.push(`${r.id.padEnd(27)} | ${pc1(r.older.annual).padStart(8)} | ${pc1(r.newer.annual).padStart(8)} [${pc1(r.newer.lo)}, ${pc1(r.newer.hi)}] | ${String(r.trades).padStart(6)} ${r.avgHoldDays.toFixed(1).padStart(8)} ${(100 * r.deployed).toFixed(0).padStart(7)}% ${String(r.forced).padStart(6)}`);
}
L.push("");
const t = res.top1;
if (t && t.newer.annual != null) L.push(`On $1,000 reserved, the top variant's newer mean is about $${(1000 * t.newer.annual).toFixed(0)} per year. The baseline's is about $${(1000 * h.newer.annual).toFixed(0)}.`);
L.push("Forced exit means the perp price rose about 80% of the way to liquidation at the chosen leverage. In real use you would add margin instead, which needs spare cash.");
L.push("");
if (res.holdPass) L.push(`VERDICT (baseline): simple carry held the whole period was positive on both halves and its newer 95% range sits above zero (${pc1(h.newer.annual)} a year).`);
else L.push("VERDICT (baseline): simple carry held the whole period does not clear zero with a 95% range on newer data.");
if (res.pass) L.push(`VERDICT (entry/exit): ${t.id} is positive on older data and its newer range sits above zero (${pc1(t.newer.annual)} a year). It is one of ${res.rows.length - 1} variants tried.`);
else L.push("VERDICT (entry/exit): no entry/exit rule survives on newer data.");
L.push("");
L.push("Limits: today's liquid coins only. Spot and perp are marked at 1h candles. Fees use the standard taker rate on both legs. Exchange risk, withdrawal limits and account restrictions are not modeled. Funding can turn negative for weeks. Weekly points are treated as independent, which flatters the 95% range.");
return L.join("\n");
}

const makeP = (opts) => ({
days: opts.days || 365, top: opts.top || 60, lev: opts.lev || 3,
feeSpot: opts.feeSpot ?? 0.001, feePerp: opts.feePerp ?? 0.00055, costMult: opts.costMult ?? 1,
});

async function loadUniverse(P, fetchJson, log, useCache) {
const universe = await pickUniverse(P.top, fetchJson);
log(`universe: ${universe.length} coins with both spot and perp, ${P.days} days`);
const datasets = [];
for (let i = 0; i < universe.length; i++) {
const u = universe[i];
try {
const d = await loadCoin(u.symbol, u.spotSym, P.days, { fetchJson, useCache });
const short = d.spot.length < 0.9 * d.perp.length;
const counts = `perp=${d.perp.length} spot=${d.spot.length} funding=${d.funding.length}`;
datasets.push({ a: prepare(d, slipPerSide(u.turnover)) }); // raw candles are dropped here
log(`loaded ${u.symbol} (${i + 1}/${universe.length}) ${counts}${short ? " SPOT SHORT" : ""} memory=${Math.round(process.memoryUsage().rss / 1e6)}MB`);
} catch (e) { log(`failed ${u.symbol}: ${e.message}`); }
}
return datasets;
}

// ─── RUN: ENTRY/EXIT CARRY ─────────────────────────────────────────────────
async function runFundingCarry(opts = {}, io = {}) {
const log = io.log || (() => {});
const fetchJson = throttled(io.fetchJson || defaultFetchJson, opts.pauseMs ?? 120);
const P = makeP(opts);
const datasets = await loadUniverse(P, fetchJson, log, opts.useCache !== false);
const res = runCarry(datasets, P);
res.report = formatReport(res);
return res;
}

// ─── RANKED CARRY ──────────────────────────────────────────────────────────
// Rules fixed BEFORE this run, not tuned on the earlier carry results:
// Every 30 days, rank coins by average funding over the previous 30 days
// (hourly-normalized, annualized). Hold the top N that are at or above the
// minimum, equal weight, $1 spot long and $1 perp short each. Coins that stay
// selected keep their position with no trading cost. Anything else in the
// report is measured, not chosen.
// Grid, 4 variants: N in {5, 10} x minimum in {0%, 10%}.
// Control: hold every coin that has funding history (no ranking). A ranking
// only counts if it beats this control on newer data.
// Capital reserved = N slots x (1 + 1/leverage), idle slots included.
const RANK = { lookbackDays: 30, rebalanceDays: 30, minRecords: 30 };
const RANK_VARIANTS = [
{ id: "top5_min0", N: 5, min: 0 },
{ id: "top5_min10", N: 5, min: 0.10 },
{ id: "top10_min0", N: 10, min: 0 },
{ id: "top10_min10", N: 10, min: 0.10 },
{ id: "all_coins", N: Infinity, min: -Infinity, control: true },
];

function lowerBound(arr, t) { let l = 0, r = arr.length; while (l < r) { const m = (l + r) >> 1; if (arr[m] < t) l = m + 1; else r = m; } return l; }

// Hold one coin's hedge from candle s (entry at the open) to candle eIdx (exit at the close).
// After a forced exit the position sits out until the next settlement, then re-enters.
function simWindow(a, s, eIdx, P, weekly, t0, acc) {
const cost = (P.feeSpot + P.feePerp + 2 * a.slip) * P.costMult;
const trig = 1 + 0.8 / P.lev;
const n = a.t.length, fs = a.fs;
const add = (i, v) => { weekly[weekIndex(weekly, a.t[i], t0)] += v; };
eIdx = Math.min(eIdx, n - 1);
let e = s;
while (e < eIdx) {
const spotE = a.so[e], perpE = a.po[e];
add(e, -cost); acc.cost += cost;
let x = e, forced = false;
for (let i = e; i <= eIdx; i++) {
x = i;
const ps = i === e ? spotE : a.sc[i - 1], pp = i === e ? perpE : a.pc[i - 1];
const mtm = (a.sc[i] - ps) / spotE - (a.pc[i] - pp) / perpE;
let pnl = mtm; acc.mtm += mtm;
const kk = i > e ? a.fAt.get(i) : undefined;
if (kk !== undefined) { const f = (fs.rate[kk] * a.po[i]) / perpE; pnl += f; acc.fund += f; }
let exit = false;
if (a.ph[i] >= perpE * trig) { exit = true; forced = true; acc.forced++; }
if (i === eIdx) exit = true;
if (exit) { pnl -= cost; acc.cost += cost; }
add(i, pnl);
if (exit) break;
}
acc.trades++;
if (!forced) break;
let j = x + 1;
while (j <= eIdx && !a.fAt.has(j)) j++;
e = j + 1;
}
}

// Rebalance dates and trailing funding per coin per date, using only records before each date.
function rankSetup(coins) {
const t0 = Math.min(...coins.map((a) => a.t[0]));
const tEnd = Math.max(...coins.map((a) => a.t[a.t.length - 1]));
const step = RANK.rebalanceDays * DAY, look = RANK.lookbackDays * DAY;
const R = [];
for (let t = t0 + step; t < tEnd; t += step) R.push(t);
if (R.length < 3) throw new Error("not enough history for three rebalances, use more days");
const metric = coins.map((a) => R.map((T) => {
let sum = 0, c = 0;
for (let k = 0; k < a.fs.ts.length; k++) if (a.fs.ts[k] >= T - look && a.fs.ts[k] < T) { sum += a.fs.hr[k]; c++; }
return c >= RANK.minRecords ? (sum / c) * 24 * 365 : null;
}));
return { t0, tEnd, R, metric };
}

function runRank(datasets, P) {
const coins = usableCoins(datasets, P);
const { tEnd, R, metric } = rankSetup(coins);

// Weeks are indexed from the first ranking date, so the first entry cost and the first days of
// funding are inside the measured series. The first 30 days have no ranking and are left out of every variant.
const wStart = R[0];
const W2 = Math.floor((tEnd - wStart) / WEEK) + 1;
const nSeries = W2 - 1; // the last bucket is empty, the partial week is folded into the one before it
const splitIdx = Math.floor(0.6 * nSeries);
const yrs = nSeries / 52;
const rows = [];
for (const v of RANK_VARIANTS) {
const slots = v.N === Infinity ? coins.length : v.N;
const capital = slots * (1 + 1 / P.lev);
const weekly = new Array(W2).fill(0);
const acc = { fund: 0, cost: 0, mtm: 0, trades: 0, forced: 0 };
const chosen = R.map((_, j) => coins.map((a, c) => ({ c, m: metric[c][j] }))
.filter((x) => x.m !== null && x.m >= v.min).sort((p, q) => q.m - p.m).slice(0, v.N).map((x) => x.c));
let heldSum = 0;
chosen.forEach((l) => { heldSum += l.length; });
coins.forEach((a, c) => {
const flags = chosen.map((l) => l.includes(c));
let j = 0;
while (j < R.length) {
if (!flags[j]) { j++; continue; }
let j1 = j;
while (j1 + 1 < R.length && flags[j1 + 1]) j1++;
const sIdx = lowerBound(a.t, R[j]) + 1;
const eIdx = j1 + 1 < R.length ? lowerBound(a.t, R[j1 + 1]) : a.t.length - 1;
if (sIdx < eIdx) simWindow(a, sIdx, eIdx, P, weekly, wStart, acc);
j = j1 + 1;
}
});
const series = weekly.slice(0, nSeries).map((x) => x / capital);
rows.push({
id: v.id, control: !!v.control, slots,
older: seriesStats(series.slice(0, splitIdx)), newer: seriesStats(series.slice(splitIdx)),
fund: acc.fund / capital / yrs, cost: acc.cost / capital / yrs, mtm: acc.mtm / capital / yrs,
trades: acc.trades, forced: acc.forced, avgHeld: heldSum / R.length,
worstWeek: Math.min(...series), maxDD: maxDrawdown(series),
});
}
const control = rows.find((r) => r.control);
const ranked = rows.filter((r) => !r.control && r.older.annual !== null).sort((a, b) => b.older.annual - a.older.annual);
const top1 = ranked[0] || null;
const pass = !!(top1 && top1.older.annual > 0 && top1.newer.lo !== null && top1.newer.lo > 0 && top1.newer.annual > control.newer.annual);
return { rows, ranked, top1, control, pass, meta: { coins: coins.length, t0: wStart, tEnd, rebalances: R.length, firstRank: R[0], splitT: wStart + splitIdx * WEEK, P } };
}

function formatRankReport(res) {
const { meta: m } = res, P = m.P, L = [];
L.push(`Ranked funding carry: ${P.days} days, ${m.coins} coins with both spot and perp, ${m.rebalances} monthly rebalances`);
L.push(`Rule, fixed before the run: every ${RANK.rebalanceDays} days rank coins by average funding of the previous ${RANK.lookbackDays} days. Hold the top N at or above the minimum, $1 spot long and $1 perp short each.`);
L.push(`Perp margin at ${P.lev}x. Capital reserved is N slots x $${(1 + 1 / P.lev).toFixed(2)}, idle slots counted. Costs per side: spot ${(P.feeSpot * 100).toFixed(2)}% + perp ${(P.feePerp * 100).toFixed(3)}% + slippage 0.02% to 0.08%, x${P.costMult}. Coins that stay selected are not traded.`);
L.push(`First ranking: ${dayStr(m.firstRank)}. Older: ${dayStr(m.firstRank)} to ${dayStr(m.splitT)}. Newer: ${dayStr(m.splitT)} to ${dayStr(m.tEnd)}. Control holds every coin with no ranking.`);
L.push("");
L.push("variant | older/yr | newer/yr 95% range | funding costs price/basis | trades forced held");
for (const r of [...res.ranked, res.control]) {
L.push(`${r.id.padEnd(13)} | ${pc1(r.older.annual).padStart(8)} | ${pc1(r.newer.annual).padStart(8)} [${pc1(r.newer.lo)}, ${pc1(r.newer.hi)}] | ${pc1(r.fund).padStart(7)} ${pl(-r.cost).padStart(7)} ${pc1(r.mtm).padStart(11)} | ${String(r.trades).padStart(6)} ${String(r.forced).padStart(6)} ${r.avgHeld.toFixed(1).padStart(4)}`);
}
L.push("Funding, costs and price/basis are whole-period averages per year on reserved capital. They add up to the whole-period net return.");
L.push("");
const t = res.top1, c = res.control;
if (t && t.newer.annual != null) L.push(`On $1,000 reserved, the top variant's newer mean is about $${(1000 * t.newer.annual).toFixed(0)} per year. The control's is about $${(1000 * c.newer.annual).toFixed(0)}.`);
L.push("");
if (res.pass) L.push(`VERDICT: ${t.id} is positive on older data, its newer 95% range sits above zero (${pc1(t.newer.annual)} a year), and it beats the no-ranking control on newer data. It is one of 4 variants tried.`);
else if (t && t.newer.annual != null && t.newer.annual <= c.newer.annual) L.push("VERDICT: ranking does not beat holding every coin on newer data. Last month's funding did not predict next month's.");
else L.push("VERDICT: no ranked variant clears zero with a 95% range on newer data.");
L.push("");
L.push("Limits: today's liquid coins only, so coins that were delisted are missing and results lean optimistic. Hedge marked at 1h candles. Funding can turn negative and spikes often reverse. A short perp leg can be liquidated in a fast rally, so you need spare margin cash. Only about 4 to 5 independent monthly decisions sit behind the newer half, so a pass is a hint, not proof.");
return L.join("\n");
}

// ─── PERSISTENCE TEST ──────────────────────────────────────────────────────
// Tests the premise behind any ranking rule directly: do coins with high trailing funding keep
// paying high funding? Each month, Spearman correlation across coins between trailing-30d funding
// and the funding actually paid over the next window. Windows do not overlap, so the monthly
// correlations are close to independent. Funding only: no costs, no price or basis.
function runPersistence(datasets, P) {
const coins = usableCoins(datasets, P);
const { tEnd, R, metric } = rankSetup(coins);
const per = [];
for (let j = 0; j < R.length; j++) {
const T0 = R[j], T1 = j + 1 < R.length ? R[j + 1] : tEnd;
const tr = [], nx = [];
coins.forEach((a, c) => {
if (metric[c][j] === null) return;
let s = 0, cnt = 0;
for (let k = 0; k < a.fs.ts.length; k++) if (a.fs.ts[k] >= T0 && a.fs.ts[k] < T1) { s += a.fs.hr[k]; cnt++; }
if (cnt < RANK.minRecords) return;
tr.push(metric[c][j]); nx.push((s / cnt) * 24 * 365);
});
if (tr.length < 8) continue;
const rho = spearman(tr, nx);
if (rho === null) continue;
const order = tr.map((_, i) => i).sort((p, q) => tr[q] - tr[p]).slice(0, 5);
per.push({ t: T0, n: tr.length, rho, topTrail: mean(order.map((i) => tr[i])), topNext: mean(order.map((i) => nx[i])), allNext: mean(nx) });
}
const rho = meanStats(per.map((p) => p.rho));
const spread = meanStats(per.map((p) => p.topNext - p.allNext));
// if every slot were replaced each month: two sides per position, mid-liquidity slippage, 12 times a year
const hurdle = 2 * (P.feeSpot + P.feePerp + 2 * 0.0004) * P.costMult * 12;
return { per, rho, spread, hurdle };
}

function formatPersistence(r) {
const L = [];
L.push("Persistence test: does last month's funding rank predict next month's?");
L.push(`Each month, coins are ranked by trailing ${RANK.lookbackDays}-day funding and compared with the funding they actually paid over the next window (Spearman rank correlation across coins). Funding only, before costs and price moves. Annualized.`);
L.push("month coins rho top5 last top5 next all next");
for (const p of r.per) L.push(`${dayStr(p.t)} ${String(p.n).padStart(5)} ${p.rho.toFixed(2).padStart(6)} ${pc1(p.topTrail).padStart(8)} ${pc1(p.topNext).padStart(8)} ${pc1(p.allNext).padStart(8)}`);
if (r.rho.mean == null) { L.push("Too few months to summarize."); return L.join("\n"); }
L.push(`Mean rho ${r.rho.mean.toFixed(2)} over ${r.rho.n} months, 95% range [${r.rho.lo == null ? "n/a" : r.rho.lo.toFixed(2)}, ${r.rho.hi == null ? "n/a" : r.rho.hi.toFixed(2)}]`);
L.push(`Top 5 by trailing funding earned ${pc1(r.spread.mean)} a year more than the average coin the next month, 95% range [${pc1(r.spread.lo)}, ${pc1(r.spread.hi)}]`);
L.push(`Cost hurdle if every slot were replaced each month: about ${pl(r.hurdle)} a year on notional (upper bound, coins that stay selected are not traded).`);
if (r.rho.lo != null && r.rho.lo > 0) {
if (r.spread.mean > r.hurdle) L.push("READING: funding rankings persist, and the top-5 advantage is larger than the cost hurdle. A ranking rule has something to work with.");
else L.push("READING: funding rankings persist, but the top-5 advantage is smaller than the cost hurdle. The persistence exists, the edge after costs is doubtful.");
} else {
L.push("READING: cannot distinguish rank persistence from zero. A ranking rule has nothing reliable to exploit.");
}
return L.join("\n");
}

// ─── FUNDING DIAGNOSTICS ───────────────────────────────────────────────────
// Checks that the simulation can see the funding it is supposed to earn, and shows where funding sits.
function formatDiagnostics(datasets, P) {
const coins = usableCoins(datasets, P);
const rows = coins.map((a) => {
const n = a.fs.ts.length, matched = a.fAt.size;
let raw = 0, hit = 0;
a.fs.rate.forEach((x) => { raw += x; });
a.fAt.forEach((k) => { hit += a.fs.rate[k]; });
return { sym: a.sym, n, matched, raw, hit, mean: mean(a.fs.hr) * 24 * 365, pos: a.fs.rate.filter((x) => x > 0).length / n };
});
const tot = rows.reduce((s, r) => s + r.n, 0), mat = rows.reduce((s, r) => s + r.matched, 0);
const L = [];
L.push("Funding diagnostics");
L.push(`Settlements loaded ${tot}, matched to a candle the simulation can credit ${mat} (${(100 * mat / tot).toFixed(1)}%), unmatched ${tot - mat}.`);
L.push(`Sum of raw funding rates ${(100 * rows.reduce((s, r) => s + r.raw, 0)).toFixed(1)}% vs sum credited ${(100 * rows.reduce((s, r) => s + r.hit, 0)).toFixed(1)}% (per $1 notional, all coins added up). A large gap means candle gaps are dropping funding.`);
const worst = [...rows].sort((a, b) => (b.n - b.matched) - (a.n - a.matched)).slice(0, 3).filter((r) => r.n - r.matched > 0);
if (worst.length) L.push(`Most unmatched: ${worst.map((r) => `${r.sym} ${r.n - r.matched}`).join(", ")}`);
L.push(`Mean annualized funding: median coin ${pc1(median(rows.map((r) => r.mean)))}, ${(100 * rows.filter((r) => r.mean > 0).length / rows.length).toFixed(0)}% of coins above zero, average share of positive settlements ${(100 * mean(rows.map((r) => r.pos))).toFixed(0)}%.`);
const srt = [...rows].sort((a, b) => b.mean - a.mean);
L.push(`Highest mean funding: ${srt.slice(0, 6).map((r) => `${r.sym} ${pc1(r.mean)}`).join(", ")}`);
L.push(`Lowest mean funding: ${srt.slice(-4).reverse().map((r) => `${r.sym} ${pc1(r.mean)}`).join(", ")}`);
return L.join("\n");
}

async function runFundingRank(opts = {}, io = {}) {
const log = io.log || (() => {});
const fetchJson = throttled(io.fetchJson || defaultFetchJson, opts.pauseMs ?? 120);
const P = makeP(opts);
const datasets = await loadUniverse(P, fetchJson, log, opts.useCache !== false);
const res = runRank(datasets, P);
res.persist = runPersistence(datasets, P);
res.report = [formatRankReport(res), "", formatPersistence(res.persist), "", formatDiagnostics(datasets, P)].join("\n");
return res;
}

// ─── ROUTES ────────────────────────────────────────────────────────────────
function mountJob(app, deps, { base, saveKey, label, minDays, run }) {
let job = { status: "idle", lines: [], report: null, error: null };
const request = deps.bybit && deps.bybit.bybitRequest ? (p, params) => deps.bybit.bybitRequest("GET", p, params) : undefined;
const note = (m) => { job.lines.push(m); if (job.lines.length > 400) job.lines.shift(); };
app.get(`${base}/start`, (req, res) => {
if (job.status === "running") return res.status(409).json({ message: "already running" });
const opts = { days: Math.min(730, Math.max(minDays, parseInt(req.query.days) || 365)), top: Math.min(150, Math.max(5, parseInt(req.query.top) || 60)) };
if (req.query.lev !== undefined) opts.lev = Math.min(10, Math.max(1, parseFloat(req.query.lev) || 3));
if (req.query.costs !== undefined) opts.costMult = Math.min(5, Math.max(0, parseFloat(req.query.costs) || 1));
job = { status: "running", lines: [], report: null, error: null };
run(opts, { fetchJson: request, log: note })
.then((r) => {
job.report = r.report; job.status = "done";
if (deps.ledger && deps.ledger.saveRemote) deps.ledger.saveRemote(saveKey, { at: new Date().toISOString(), text: r.report });
if (deps.log) deps.log("success", `${label} finished`);
})
.catch((e) => { job.error = e.message; job.status = "failed"; if (deps.log) deps.log("error", `${label} failed: ${e.message}`); });
res.status(202).json({ message: "started", opts, next: `GET ${base}/report` });
});
app.get(`${base}/report`, async (req, res) => {
if (job.status === "done") return res.type("text/plain").send(job.report);
if (job.status === "failed") return res.status(500).type("text/plain").send(`FAILED: ${job.error}\n\n${job.lines.slice(-20).join("\n")}`);
if (job.status === "running") return res.status(202).type("text/plain").send(`running\n\n${job.lines.slice(-8).join("\n")}`);
try {
const saved = deps.ledger && deps.ledger.loadRemote ? await deps.ledger.loadRemote(saveKey) : null;
if (saved && saved.text) return res.type("text/plain").send(`(NO RUN IS ACTIVE on this server. This is the last saved report, from ${saved.at}. If you started a new run and see this, the server restarted and the run was lost.)\n\n${saved.text}`);
} catch (e) { /* fall through */ }
res.status(404).type("text/plain").send(`No report yet. Open ${base}/start first.`);
});
}

function mountRoutes(app, deps = {}) {
mountJob(app, deps, { base: "/carry", saveKey: "carry_backtest_report", label: "carry backtest", minDays: 30, run: runFundingCarry });
mountJob(app, deps, { base: "/carry/rank", saveKey: "carry_rank_report", label: "ranked carry backtest", minDays: 120, run: runFundingRank });
}

if (require.main === module) {
const a = process.argv.slice(2);
const get = (k, d) => { const i = a.indexOf("--" + k); return i >= 0 ? a[i + 1] : d; };
const opts = { days: parseInt(get("days", "365")), top: parseInt(get("top", "60")), lev: parseFloat(get("lev", "3")), costMult: parseFloat(get("costs", "1")) };
const mode = get("mode", "carry");
const run = mode === "rank" ? runFundingRank : runFundingCarry;
console.log(`funding-carry (${mode}): ${opts.days} days, top ${opts.top} coins (first run downloads several minutes; later runs reuse ${CACHE_DIR} for 24h)`);
run(opts, { log: (m) => console.log(m) }).then((r) => console.log("\n" + r.report)).catch((e) => { console.error("Failed:", e.message); process.exit(1); });
}

module.exports = { runFundingCarry, runCarry, runFundingRank, runRank, runPersistence, formatDiagnostics, mountRoutes, prepare, simCoin, simWindow, buildVariants, formatReport, formatRankReport, formatPersistence, spearman };

Ranked funding carry: 730 days, 35 coins with both spot and perp, 24 monthly rebalances
Rule, fixed before the run: every 30 days rank coins by average funding of the previous 30 days. Hold the top N at or above the minimum, $1 spot long and $1 perp short each.
Perp margin at 3x. Capital reserved is N slots x $1.33, idle slots counted. Costs per side: spot 0.10% + perp 0.055% + slippage 0.02% to 0.08%, x1. Coins that stay selected are not traded.
First ranking: 2024-10-24. Older: 2024-10-24 to 2025-12-18. Newer: 2025-12-18 to 2026-09-24. Control holds every coin with no ranking.

variant | older/yr | newer/yr 95% range | funding costs price/basis | trades forced held
top5_min10 | +1.4% | -0.1% [-0.5%, +0.3%] | +1.6% -0.8% +0.1% | 23 9 0.8
top10_min10 | +1.3% | -0.0% [-0.2%, +0.2%] | +1.3% -0.6% +0.0% | 36 13 1.3
top10_min0 | +1.2% | -1.1% [-2.4%, +0.2%] | +3.8% -3.5% +0.0% | 206 76 10.0
top5_min0 | +1.1% | -1.8% [-3.5%, -0.2%] | +4.1% -4.2% -0.0% | 123 43 5.0
all_coins | +2.0% | +0.0% [-0.4%, +0.4%] | +2.0% -0.8% -0.0% | 157 122 35.0
Funding, costs and price/basis are whole-period averages per year on reserved capital. They add up to the whole-period net return.

On $1,000 reserved, the top variant's newer mean is about $-1 per year. The control's is about $0.

VERDICT: ranking does not beat holding every coin on newer data. Last month's funding did not predict next month's.

Limits: today's liquid coins only, so coins that were delisted are missing and results lean optimistic. Hedge marked at 1h candles. Funding can turn negative and spikes often reverse. A short perp leg can be liquidated in a fast rally, so you need spare margin cash. Only about 4 to 5 independent monthly decisions sit behind the newer half, so a pass is a hint, not proof.

Persistence test: does last month's funding rank predict next month's?
Each month, coins are ranked by trailing 30-day funding and compared with the funding they actually paid over the next window (Spearman rank correlation across coins). Funding only, before costs and price moves. Annualized.
month coins rho top5 last top5 next all next
2024-10-24 34 0.38 +10.1% +15.8% +14.4%
2024-11-23 35 0.40 +24.6% +32.0% +25.2%
2024-12-23 35 0.53 +34.2% +10.7% +5.0%
2025-01-22 35 0.37 +11.3% +2.8% +1.8%
2025-02-21 35 0.49 +6.5% +4.4% -0.9%
2025-03-23 35 0.60 +6.0% +3.2% +0.3%
2025-04-22 35 0.56 +5.1% +6.9% +4.5%
2025-05-22 35 0.29 +7.6% +5.1% +2.7%
2025-06-21 35 0.45 +6.7% +5.7% +4.5%
2025-07-21 35 0.50 +7.8% +8.9% +7.0%
2025-08-20 35 0.22 +9.7% +9.3% +8.1%
2025-09-19 35 0.01 +9.5% -0.3% -3.8%
2025-10-19 35 0.41 +5.2% +2.0% -2.6%
2025-11-18 35 0.49 +4.8% +2.5% -0.7%
2025-12-18 35 0.49 +3.7% +5.8% +2.9%
2026-01-17 35 0.50 +6.8% +0.6% -0.8%
2026-02-16 35 0.51 +3.8% -0.8% -10.7%
2026-03-18 35 0.58 +2.3% +1.2% -1.7%
2026-04-17 35 0.52 +3.6% +3.5% +0.3%
2026-05-17 35 0.47 +4.4% +4.1% +0.6%
2026-06-16 35 0.68 +5.6% +4.4% +1.5%
2026-07-16 35 0.59 +5.0% +5.2% +2.0%
2026-08-15 35 0.52 +6.2% +7.2% +5.2%
2026-09-14 35 0.33 +7.6% +6.1% +5.6%
Mean rho 0.45 over 24 months, 95% range [0.39, 0.51]
Top 5 by trailing funding earned +3.2% a year more than the average coin the next month, 95% range [+2.3%, +4.1%]
Cost hurdle if every slot were replaced each month: about 5.6% a year on notional (upper bound, coins that stay selected are not traded).
READING: funding rankings persist, but the top-5 advantage is smaller than the cost hurdle. The persistence exists, the edge after costs is doubtful.

Funding diagnostics
Settlements loaded 89650, matched to a candle the simulation can credit 89592 (99.9%), unmatched 58.
Sum of raw funding rates 208.3% vs sum credited 212.6% (per $1 notional, all coins added up). A large gap means candle gaps are dropping funding.
Most unmatched: VIRTUALUSDT 58
Mean annualized funding: median coin +3.8%, 83% of coins above zero, average share of positive settlements 72%.
Highest mean funding: 1000PEPEUSDT +6.8%, SUIUSDT +6.2%, LINKUSDT +6.0%, NEARUSDT +5.9%, DOGEUSDT +5.9%, ARBUSDT +5.8%
Lowest mean funding: INJUSDT -15.8%, ENAUSDT -7.9%, ZROUSDT -4.6%, APTUSDT -4.2%

i need a new owe strategy if this one doesn't make a research and give me something better

Done. I rebuilt it as BRF v2 with the changes we discussed:

6-hour minimum hold
No immediate basis stop
Adverse basis stop based on 50% expansion from entry
Basis convergence exit
Funding-collapse exit
72-hour maximum hold
Top 50 research universe
$10M minimum 24h turnover
One position per symbol
Maximum 5 simultaneous positions
Detailed trade-level reporting
Same cost assumptions
Walk-forward results

Download BRF v2 Backtest for Render

Deploy it the same way as before.

After deployment, run:

/backtest/start?days=730&top=50

Then send me the /backtest/report result.

Don't change the parameters before sending me the result. I want to see what the predefined BRF v2 rules actually produce first. 

BRF v2 Backtest

Basis Reversion + Funding Confirmation. Backtest only.

Days Top symbols Start backtest

done | Backtest complete. | 100%

Report
{
  "days": 730,
  "symbols": [
    "BTCUSDT",
    "ETHUSDT",
    "XRPUSDT",
    "SOLUSDT",
    "NEARUSDT",
    "HYPEUSDT",
    "ONDOUSDT",
    "DOGEUSDT",
    "LTCUSDT",
    "ENAUSDT",
    "SUIUSDT",
    "UNIUSDT",
    "BCHUSDT",
    "ADAUSDT",
    "ARBUSDT",
    "WLDUSDT",
    "ZROUSDT",
    "AVAXUSDT",
    "LITUSDT",
    "PENGUUSDT",
    "AAVEUSDT",
    "TRUMPUSDT",
    "LINKUSDT",
    "INJUSDT",
    "BNBUSDT",
    "FLOCKUSDT",
    "XAUTUSDT",
    "XPLUSDT",
    "XLMUSDT",
    "NOMUSDT",
    "PONSUSDT",
    "VVVUSDT",
    "ETCUSDT",
    "APTUSDT",
    "OPUSDT",
    "WIFUSDT",
    "MNTUSDT",
    "FILUSDT",
    "DOTUSDT",
    "WLFIUSDT",
    "HBARUSDT",
    "ICPUSDT",
    "TIAUSDT",
    "VIRTUALUSDT",
    "SPXUSDT",
    "AEROUSDT",
    "ASTERUSDT",
    "BRUSDT",
    "PENDLEUSDT",
    "CRVUSDT"
  ],
  "trades": 19,
  "wins": 11,
  "losses": 8,
  "winRate": 0.5789473684210527,
  "totalNet": -0.01385596009068944,
  "annualizedReturn": -0.0069279800453447195,
  "fundingPnl": 0.003901075,
  "basisPnl": 0.030199710845993377,
  "grossPnl": 0.07544403990931056,
  "costs": 0.08929999999999999,
  "avgTrade": -0.0007292610574047074,
  "medianTrade": 0.0005755725016366176,
  "avgHoldHours": 7.894736842105263,
  "maxDrawdown": 0.06642464785706786,
  "profitFactor": 0.8720180209293006,
  "bestTrade": 0.016890544857201942,
  "worstTrade": -0.040410167684327404,
  "exits": {
    "basis-converged": 14,
    "adverse-basis-stop": 5
  }
}

This run is much more informative than v1.

The signal is showing some real behavior, but the strategy still fails after trading costs.

What the numbers say
Metric	BRF v2
Trades	19
Win rate	57.9%
Gross P&L	+$0.0754
Basis P&L	+$0.0302
Funding P&L	+$0.0039
Costs	-$0.0893
Net P&L	-$0.0139
Profit factor	0.87
Avg hold	7.9 hours
Max drawdown	-$0.0664
Best trade	+$0.0169
Worst trade	-$0.0404

The important part is:

The signal generated positive gross P&L, but the trading friction consumed more than the entire edge.

Average per trade:

Gross:   +0.397%
Costs:   -0.470%
----------------
Net:     -0.073%

So we're very close, but not profitable under the current execution assumptions.

The good part

The basis component is doing what we wanted:

Basis P&L:   +3.02%
Funding:     +0.39%

That means the strategy isn't completely random. Basis convergence is actually producing positive P&L.

Also:

11 winners
8 losers
57.9% win rate

That's useful.

But the -4.04% worst trade is a serious problem. A basis trade can still lose substantially when the perp premium expands instead of converging.

The biggest problem is now obvious

It's not the entry signal anymore.

It's trade economics + tail risk.

We're paying approximately:

0.47% round trip

under the current assumptions.

And we're holding for only:

7.9 hours average

That isn't enough time for funding to contribute much.

So BRF is currently doing this:

Enter
↓
Capture basis movement
↓
Pay ~0.47%
↓
Funding barely contributes
↓
One bad basis expansion wipes out several small winners

That's why 58% winners can still produce a negative result.

I would NOT simply reduce the fees

This is important.

We shouldn't change:

0.47% → 0.20%

just because that makes the backtest profitable.

If the strategy requires extremely good execution to work, we need to know that.

Instead, I want the next test to answer:

Can we improve the trade selection enough that the strategy remains profitable even with the same conservative costs?

BRF v3 should focus on quality, not more trades

I would make these changes:

1. Require larger basis

Current:

basis >= 0.50%

Test:

basis >= 0.80%

and separately:

basis >= 1.00%

Not both at once. These should be separate pre-declared variants.

2. Require stronger expected edge

Current hurdle:

expected edge >= 1.5 × round-trip cost

Test:

expected edge >= 2.0 × round-trip cost

This should reduce marginal trades.

3. Improve the adverse-basis stop

The current:

basis expands 50% from entry

allowed a potentially large loss.

Instead, we should calculate the adverse move in basis percentage points, not just relative percentage.

For example:

Entry basis = 1.00%

Normal basis = 0.30%

Expected convergence = 0.70%

If the basis reaches:

1.50%

that's already a major deterioration.

The stop should be based on the historical basis distribution and the actual entry basis.

4. Add a market-wide basis stress filter

This is more important than another random indicator.

If several major coins simultaneously show rapidly expanding perp basis, the market may be entering a leverage expansion regime.

In that situation:

Don't open new basis trades.

This could help with the -4% type losses.

One thing I want to fix before v3

There is also a reporting issue worth cleaning up.

You have:

Basis P&L     +3.02%
Funding       +0.39%
Gross P&L     +7.54%

Those components don't reconcile cleanly.

That doesn't automatically mean the simulation is wrong, because the actual spot and perp legs can create residual price P&L, but the report should explicitly show:

Spot P&L
Perp P&L
Basis convergence P&L
Funding P&L
Gross P&L
Entry costs
Exit costs
Slippage
Net P&L

That will let us see exactly where the extra +4.13% gross P&L is coming from.

I would fix that before trusting the next result.

My read right now

BRF v1: too restrictive, only 2 trades.

BRF v2: much better signal activity and positive gross edge, but costs and tail losses destroy the net result.

BRF v3: should focus on fewer, higher-edge trades + better tail protection + clean P&L attribution.

I would not put money behind v2 based on this result. The next test should be v3, using the same 730-day period so we can directly compare it against v2 rather than moving the goalposts.

Today 9:05 PM
okay

Good. The key takeaway from the BRF v2 result is: don’t tune it toward profitability yet. First fix the accounting and then test a stricter v3 against the exact same 730-day period and costs.

The next version should compare:

v2 baseline
v3A: minimum basis 0.8%
v3B: minimum basis 1.0%
Exact funding-settlement accounting
Separate spot P&L, perp P&L, funding, fees, and slippage
6-hour minimum hold
72-hour maximum hold
Stronger entry-edge requirement
Market-wide basis-stress filter
Same 0.10% spot + 0.055% perp fees and 0.04% slippage assumptions

Most importantly, we'll be able to see where the -1.39% actually comes from, rather than just changing parameters until the backtest looks good.

And we'll keep this strictly as a backtesting/research project, not treat the results as proof that a live strategy will make money.

You're on the free plan
ChatGPT gets less accurate and may forget details in long conversations. Upgrade to chat longer with better memory.
Get Plus
New chat
