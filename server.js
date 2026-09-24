from pathlib import Path

code = r"""'use strict';

/*
  BRF v3: Basis Reversion + Funding Confirmation
  Backtest only. Uses public Bybit V5 market-data endpoints.

  This version keeps the existing BRF architecture while:
  - Using actual funding settlement events for PnL.
  - Keeping the hourly funding series only for signal confirmation.
  - Avoiding look-ahead in rolling statistics and funding signals.
  - Applying entry/exit costs consistently.
  - Reporting detailed diagnostics.
*/

const http = require('http');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 10000);
const API = process.env.BYBIT_BASE_URL || 'https://api.bybit.com';

const CFG = {
  interval: '60',
  defaultDays: Number(process.env.DAYS || 730),
  top: Number(process.env.TOP || 50),

  slotNotional: Number(process.env.SLOT_NOTIONAL || 1),
  maxConcurrent: Number(process.env.MAX_CONCURRENT || 5),
  minHoldHours: Number(process.env.MIN_HOLD_HOURS || 6),

  basisLookbackHours: Number(process.env.BASIS_LOOKBACK_HOURS || 336),
  entryZ: Number(process.env.ENTRY_Z || 2.0),
  minBasis: Number(process.env.MIN_BASIS || 0.0080),
  exitZ: Number(process.env.EXIT_Z || 0.50),
  stopZ: Number(process.env.STOP_Z || 4.00),
  maxHoldHours: Number(process.env.MAX_HOLD_HOURS || 72),

  fundingShortHours: Number(process.env.FUNDING_SHORT_HOURS || 72),
  fundingLongHours: Number(process.env.FUNDING_LONG_HOURS || 168),
  minFunding3dAnn: Number(process.env.MIN_FUNDING_3D_ANN || 0.05),
  minFunding7dAnn: Number(process.env.MIN_FUNDING_7D_ANN || 0.03),
  fundingStability: Number(process.env.FUNDING_STABILITY || 0.70),

  btcStress24h: Number(process.env.BTC_STRESS_24H || -0.04),

  spotFee: Number(process.env.SPOT_FEE || 0.0010),
  perpFee: Number(process.env.PERP_FEE || 0.00055),
  slippage: Number(process.env.SLIPPAGE || 0.00040),

  klineLimit: 1000,
  fundingLimit: 200,
  requestDelayMs: Number(process.env.REQUEST_DELAY_MS || 80),
  concurrency: Number(process.env.CONCURRENCY || 4),
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 20000),

  minNetEdgeMultiple: Number(process.env.MIN_NET_EDGE_MULTIPLE || 1.00),

  minTurnover24h: Number(process.env.MIN_TURNOVER_24H || 10_000_000),
  marketStressBreadth: Number(process.env.MARKET_STRESS_BREADTH || 0.50),
  marketStressBasisRise6h: Number(process.env.MARKET_STRESS_BASIS_RISE_6H || 0.0025),
  adverseBasisFloor: Number(process.env.ADVERSE_BASIS_FLOOR || 0.0050),
  adverseZExtra: Number(process.env.ADVERSE_Z_EXTRA || 2.0)
};

const state = {
  running: false,
  startedAt: null,
  finishedAt: null,
  progress: 0,
  stage: 'idle',
  message: '',
  report: null,
  error: null
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function nowMs() {
  return Date.now();
}

function annualizeFunding(sumHourlyRates) {
  return sumHourlyRates * 24 * 365;
}

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

async function api(path, params = {}, attempt = 0) {
  const qs = new URLSearchParams();

  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      qs.set(k, String(v));
    }
  }

  const url = `${API}${path}?${qs.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.requestTimeoutMs);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'BRF-Backtest/3.0' },
      signal: controller.signal
    });

    const text = await res.text();

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = JSON.parse(text);

    if (data.retCode !== 0) {
      throw new Error(`Bybit ${data.retCode}: ${data.retMsg}`);
    }

    await sleep(CFG.requestDelayMs);
    return data;
  } catch (err) {
    if (attempt < 4) {
      await sleep(500 * Math.pow(2, attempt));
      return api(path, params, attempt + 1);
    }

    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function getInstruments(category) {
  let cursor = '';
  const all = [];

  do {
    const data = await api('/v5/market/instruments-info', {
      category,
      limit: 1000,
      cursor: cursor || undefined
    });

    const list = data.result?.list || [];
    all.push(...list);
    cursor = data.result?.nextPageCursor || '';
  } while (cursor);

  return all;
}

async function getTickers(category) {
  const data = await api('/v5/market/tickers', { category });
  return data.result?.list || [];
}

async function getUniverse(top) {
  state.stage = 'universe';
  state.message = 'Loading Bybit instruments and 24h turnover...';

  const [linear, spot, linearTickers] = await Promise.all([
    getInstruments('linear'),
    getInstruments('spot'),
    getTickers('linear')
  ]);

  const spotSymbols = new Set(
    spot
      .filter(x => x.status === 'Trading' && x.quoteCoin === 'USDT')
      .map(x => x.symbol)
  );

  const turnover = new Map(
    linearTickers.map(x => [x.symbol, safeNum(x.turnover24h)])
  );

  return linear
    .filter(x =>
      x.status === 'Trading' &&
      x.contractType === 'LinearPerpetual' &&
      x.quoteCoin === 'USDT' &&
      spotSymbols.has(x.baseCoin + 'USDT')
    )
    .map(x => ({
      symbol: x.symbol,
      spot: x.baseCoin + 'USDT',
      turnover24h: turnover.get(x.symbol) || 0
    }))
    .filter(x => x.turnover24h >= CFG.minTurnover24h)
    .sort((a, b) => b.turnover24h - a.turnover24h)
    .slice(0, top);
}

async function getKlines(category, symbol, start, end) {
  const pages = [];
  let cursorEnd = end;

  while (cursorEnd > start) {
    const data = await api('/v5/market/kline', {
      category,
      symbol,
      interval: CFG.interval,
      start,
      end: cursorEnd,
      limit: CFG.klineLimit
    });

    const list = data.result?.list || [];
    if (!list.length) break;

    pages.push(...list);

    const oldest = Math.min(...list.map(x => Number(x[0])));

    if (!Number.isFinite(oldest) || oldest <= start) break;

    cursorEnd = oldest - 1;

    if (pages.length > 50000) break;
  }

  const dedup = new Map();

  for (const r of pages) {
    const t = Number(r[0]);

    if (t >= start && t <= end) {
      dedup.set(t, {
        t,
        o: Number(r[1]),
        h: Number(r[2]),
        l: Number(r[3]),
        c: Number(r[4]),
        v: Number(r[5]),
        turnover: Number(r[6])
      });
    }
  }

  return [...dedup.values()].sort((a, b) => a.t - b.t);
}

async function getFunding(symbol, start, end) {
  const pages = [];
  let cursorEnd = end;

  while (cursorEnd > start) {
    const data = await api('/v5/market/funding/history', {
      category: 'linear',
      symbol,
      endTime: cursorEnd,
      limit: CFG.fundingLimit
    });

    const list = data.result?.list || [];
    if (!list.length) break;

    pages.push(...list);

    const oldest = Math.min(
      ...list.map(x => Number(x.fundingRateTimestamp))
    );

    if (!Number.isFinite(oldest) || oldest <= start) break;

    cursorEnd = oldest - 1;

    if (pages.length > 10000) break;
  }

  const dedup = new Map();

  for (const r of pages) {
    const t = Number(r.fundingRateTimestamp);

    if (t >= start && t <= end) {
      dedup.set(t, {
        t,
        rate: Number(r.fundingRate)
      });
    }
  }

  return [...dedup.values()].sort((a, b) => a.t - b.t);
}

function rollingMeanStd(values, endIndex, lookback) {
  const start = Math.max(0, endIndex - lookback);
  const arr = [];

  for (let i = start; i < endIndex; i++) {
    const v = values[i];
    if (Number.isFinite(v)) arr.push(v);
  }

  if (arr.length < Math.max(48, Math.floor(lookback * 0.5))) {
    return { mean: NaN, std: NaN, n: arr.length };
  }

  let sum = 0;

  for (const v of arr) {
    sum += v;
  }

  const mean = sum / arr.length;

  let ss = 0;

  for (const v of arr) {
    ss += (v - mean) ** 2;
  }

  const std = Math.sqrt(ss / Math.max(1, arr.length - 1));

  return {
    mean,
    std,
    n: arr.length
  };
}

function rollingSum(values, endIndex, lookback) {
  const start = Math.max(0, endIndex - lookback);

  let sum = 0;
  let n = 0;

  for (let i = start; i < endIndex; i++) {
    const v = values[i];

    if (Number.isFinite(v)) {
      sum += v;
      n++;
    }
  }

  return { sum, n };
}

/*
  Signal model:
  Funding settlements are mapped to the first hourly candle after settlement.
  The hourly series is used only to estimate recent funding conditions.

  PnL model:
  Funding PnL is calculated separately from the actual settlement events.
  This avoids accidentally counting funding twice.
*/
function makeFundingHourly(candles, fundingEvents) {
  const hr = new Array(candles.length).fill(0);

  for (const event of fundingEvents) {
    let idx = candles.findIndex(c => c.t >= event.t);

    if (idx < 0) continue;

    const nextEventIndex = fundingEvents.indexOf(event) + 1;
    const next = fundingEvents[nextEventIndex];

    const gapH = next
      ? Math.max(1, (next.t - event.t) / 3600000)
      : 8;

    const perHour = event.rate / gapH;
    const end = next
      ? Math.min(candles.length, idx + Math.ceil(gapH))
      : candles.length;

    for (let i = idx; i < end; i++) {
      hr[i] += perHour;
    }
  }

  return hr;
}

function alignData(spot, perp, funding) {
  const pMap = new Map(perp.map(x => [x.t, x]));
  const sMap = new Map(spot.map(x => [x.t, x]));

  const candles = [];

  for (const [t, s] of sMap) {
    const p = pMap.get(t);

    if (!p) continue;

    candles.push({
      t,
      so: s.o,
      sh: s.h,
      sl: s.l,
      sc: s.c,
      po: p.o,
      ph: p.h,
      pl: p.l,
      pc: p.c
    });
  }

  candles.sort((a, b) => a.t - b.t);

  return {
    t: candles.map(x => x.t),
    so: candles.map(x => x.so),
    sc: candles.map(x => x.sc),
    pc: candles.map(x => x.pc),
    ph: candles.map(x => x.ph),
    pl: candles.map(x => x.pl),
    fundingHr: makeFundingHourly(candles, funding),
    fundingEvents: funding
  };
}

function basisSeries(a) {
  return a.pc.map((p, i) => {
    const s = a.sc[i];

    return Number.isFinite(p) &&
      Number.isFinite(s) &&
      s > 0
      ? p / s - 1
      : NaN;
  });
}

function costOneWay() {
  return CFG.spotFee + CFG.perpFee + 2 * CFG.slippage;
}

function roundTripCost() {
  return 2 * costOneWay();
}

function tradePnl(a, basis, fundingEvents, entryI, exitI, notional) {
  const spotEntry = a.so[entryI];
  const perpEntry = a.pc[entryI];

  const spotExit = a.so[exitI];
  const perpExit = a.pc[exitI];

  const spotPnl =
    notional * (spotExit / spotEntry - 1);

  const perpPnl =
    notional * (1 - perpExit / perpEntry);

  const entryT = a.t[entryI];
  const exitT = a.t[exitI];

  let funding = 0;
  let fundingSettlements = 0;

  for (const event of fundingEvents) {
    if (event.t > entryT && event.t <= exitT) {
      /*
        Long spot + short perpetual.
        Positive funding means shorts receive funding.
      */
      funding += notional * event.rate;
      fundingSettlements++;
    }
  }

  const entryFee =
    notional * (CFG.spotFee + CFG.perpFee);

  const exitFee =
    notional * (CFG.spotFee + CFG.perpFee);

  const entrySlippage =
    notional * (2 * CFG.slippage);

  const exitSlippage =
    notional * (2 * CFG.slippage);

  const costs =
    entryFee +
    exitFee +
    entrySlippage +
    exitSlippage;

  const basisDeltaPnl =
    notional * (basis[entryI] - basis[exitI]);

  const mechanicalGross =
    spotPnl +
    perpPnl +
    funding;

  const net =
    mechanicalGross -
    costs;

  return {
    spotPnl,
    perpPnl,
    basisDeltaPnl,
    fundingPnl: funding,
    fundingSettlements,
    mechanicalGross,
    gross: mechanicalGross,
    entryFee,
    exitFee,
    entrySlippage,
    exitSlippage,
    costs,
    net
  };
}

function simulateCoin(
  a,
  symbol,
  marketStressByTime,
  minBasisOverride = CFG.minBasis
) {
  const basis = basisSeries(a);
  const trades = [];

  let open = null;

  const startI = Math.max(
    CFG.basisLookbackHours + 24,
    CFG.fundingLongHours + 24
  );

  for (
    let i = startI;
    i < a.t.length - 1;
    i++
  ) {
    if (!Number.isFinite(basis[i])) continue;

    const stats =
      rollingMeanStd(
        basis,
        i,
        CFG.basisLookbackHours
      );

    if (
      !Number.isFinite(stats.std) ||
      stats.std <= 0
    ) {
      continue;
    }

    const z =
      (basis[i] - stats.mean) /
      stats.std;

    const f3 =
      rollingSum(
        a.fundingHr,
        i + 1,
        CFG.fundingShortHours
      );

    const f7 =
      rollingSum(
        a.fundingHr,
        i + 1,
        CFG.fundingLongHours
      );

    if (
      f3.n < CFG.fundingShortHours * 0.7 ||
      f7.n < CFG.fundingLongHours * 0.7
    ) {
      continue;
    }

    const f3Ann =
      annualizeFunding(f3.sum);

    const f7Ann =
      annualizeFunding(f7.sum);

    const fundingStable =
      f3Ann >= CFG.fundingStability * f7Ann;

    const marketStress =
      marketStressByTime.get(a.t[i]) === true;

    if (!open) {
      if (
        !marketStress &&
        z >= CFG.entryZ &&
        basis[i] >= minBasisOverride &&
        f3Ann >= CFG.minFunding3dAnn &&
        f7Ann >= CFG.minFunding7dAnn &&
        fundingStable
      ) {
        const expectedBasis =
          Math.max(
            0,
            basis[i] - stats.mean
          );

        const expectedFunding =
          Math.max(
            0,
            f7Ann *
              (CFG.maxHoldHours / 24 / 365)
          );

        const expectedEdge =
          expectedBasis +
          expectedFunding;

        const requiredEdge =
          roundTripCost() *
          (1 + CFG.minNetEdgeMultiple);

        if (expectedEdge >= requiredEdge) {
          open = {
            signalI: i,
            entryI: i + 1,
            entryBasis: basis[i + 1],
            entryZ: z,
            entryFunding3d: f3Ann,
            entryFunding7d: f7Ann,
            expectedBasis,
            expectedFunding,
            requiredEdge
          };
        }
      }

      continue;
    }

    const held =
      i - open.entryI + 1;

    const fundingCollapse =
      f3Ann <= 0 ||
      f3Ann <= open.entryFunding3d * 0.25;

    const basisConverged =
      held >= CFG.minHoldHours &&
      z <= CFG.exitZ;

    const basisStd =
      Number.isFinite(stats.std)
        ? stats.std
        : 0;

    const adverseBasis =
      held >= CFG.minHoldHours &&
      (
        basis[i] >=
          open.entryBasis +
          Math.max(
            CFG.adverseBasisFloor,
            basisStd
          ) ||
        z >=
          open.entryZ +
          CFG.adverseZExtra
      );

    const maxHold =
      held >= CFG.maxHoldHours;

    if (
      basisConverged ||
      fundingCollapse ||
      adverseBasis ||
      maxHold
    ) {
      const exitI =
        Math.min(
          i + 1,
          a.t.length - 1
        );

      const exitStats =
        rollingMeanStd(
          basis,
          i,
          CFG.basisLookbackHours
        );

      const exitZ =
        Number.isFinite(exitStats.std) &&
        exitStats.std > 0
          ? (
              basis[i] -
              exitStats.mean
            ) / exitStats.std
          : NaN;

      const pnl =
        tradePnl(
          a,
          basis,
          a.fundingEvents,
          open.entryI,
          exitI,
          CFG.slotNotional
        );

      trades.push({
        symbol,
        entryTime: a.t[open.entryI],
        exitTime: a.t[exitI],
        holdHours:
          (a.t[exitI] -
            a.t[open.entryI]) /
          3600000,
        entryBasis:
          basis[open.entryI],
        exitBasis:
          basis[exitI],
        basisChange:
          basis[exitI] -
          basis[open.entryI],
        entryZ: open.entryZ,
        exitZ,
        entryFunding3d:
          open.entryFunding3d,
        entryFunding7d:
          open.entryFunding7d,
        expectedBasisAtEntry:
          open.expectedBasis,
        expectedFundingAtEntry:
          open.expectedFunding,
        requiredEdgeAtEntry:
          open.requiredEdge,
        reason:
          basisConverged
            ? 'basis-converged'
            : fundingCollapse
              ? 'funding-collapsed'
              : adverseBasis
                ? 'adverse-basis-stop'
                : 'max-hold',
        ...pnl
      });

      open = null;
    }
  }

  if (open) {
    const exitI =
      a.t.length - 1;

    const exitStats =
      rollingMeanStd(
        basis,
        exitI,
        CFG.basisLookbackHours
      );

    const exitZ =
      Number.isFinite(exitStats.std) &&
      exitStats.std > 0
        ? (
            basis[exitI] -
            exitStats.mean
          ) / exitStats.std
        : NaN;

    const pnl =
      tradePnl(
        a,
        basis,
        a.fundingEvents,
        open.entryI,
        exitI,
        CFG.slotNotional
      );

    trades.push({
      symbol,
      entryTime: a.t[open.entryI],
      exitTime: a.t[exitI],
      holdHours:
        (a.t[exitI] -
          a.t[open.entryI]) /
        3600000,
      entryBasis:
        basis[open.entryI],
      exitBasis:
        basis[exitI],
      basisChange:
        basis[exitI] -
        basis[open.entryI],
      entryZ: open.entryZ,
      exitZ,
      entryFunding3d:
        open.entryFunding3d,
      entryFunding7d:
        open.entryFunding7d,
      expectedBasisAtEntry:
        open.expectedBasis,
      expectedFundingAtEntry:
        open.expectedFunding,
      requiredEdgeAtEntry:
        open.requiredEdge,
      reason: 'end-of-test',
      ...pnl
    });
  }

  return trades;
}

function aggregateTrades(
  trades,
  days,
  symbols
) {
  const totalNet =
    trades.reduce(
      (s, t) => s + t.net,
      0
    );

  const totalFunding =
    trades.reduce(
      (s, t) => s + t.fundingPnl,
      0
    );

  const totalBasis =
    trades.reduce(
      (s, t) => s + t.basisDeltaPnl,
      0
    );

  const totalSpot =
    trades.reduce(
      (s, t) => s + t.spotPnl,
      0
    );

  const totalPerp =
    trades.reduce(
      (s, t) => s + t.perpPnl,
      0
    );

  const totalEntryFees =
    trades.reduce(
      (s, t) => s + t.entryFee,
      0
    );

  const totalExitFees =
    trades.reduce(
      (s, t) => s + t.exitFee,
      0
    );

  const totalEntrySlippage =
    trades.reduce(
      (s, t) => s + t.entrySlippage,
      0
    );

  const totalExitSlippage =
    trades.reduce(
      (s, t) => s + t.exitSlippage,
      0
    );

  const totalFundingSettlements =
    trades.reduce(
      (s, t) => s + t.fundingSettlements,
      0
    );

  const totalCosts =
    trades.reduce(
      (s, t) => s + t.costs,
      0
    );

  const totalGross =
    trades.reduce(
      (s, t) => s + t.gross,
      0
    );

  const wins =
    trades.filter(t => t.net > 0);

  const losses =
    trades.filter(t => t.net < 0);

  const daily = new Map();

  for (const t of trades) {
    const d =
      new Date(t.exitTime)
        .toISOString()
        .slice(0, 10);

    daily.set(
      d,
      (daily.get(d) || 0) +
        t.net
    );
  }

  const dailyReturns =
    [...daily.values()];

  let equity = 0;
  let peak = 0;
  let maxDD = 0;

  for (const d of dailyReturns) {
    equity += d;
    peak = Math.max(
      peak,
      equity
    );

    maxDD = Math.max(
      maxDD,
      peak - equity
    );
  }

  const avg =
    trades.length
      ? totalNet / trades.length
      : 0;

  const sorted =
    [...trades]
      .sort(
        (a, b) =>
          a.net - b.net
      );

  const med =
    trades.length
      ? sorted[
          Math.floor(
            trades.length / 2
          )
        ].net
      : 0;

  const lossAmount =
    losses.reduce(
      (s, t) =>
        s + Math.abs(t.net),
      0
    );

  const profitFactor =
    lossAmount > 0
      ? wins.reduce(
          (s, t) =>
            s + t.net,
          0
        ) / lossAmount
      : Infinity;

  return {
    days,
    symbols,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate:
      trades.length
        ? wins.length /
          trades.length
        : 0,

    totalNet,

    annualizedReturn:
      days > 0
        ? totalNet *
          (365 / days)
        : 0,

    fundingPnl: totalFunding,
    fundingSettlements:
      totalFundingSettlements,

    spotPnl: totalSpot,
    perpPnl: totalPerp,
    basisDeltaPnl: totalBasis,
    grossPnl: totalGross,

    entryFees: totalEntryFees,
    exitFees: totalExitFees,

    entrySlippage:
      totalEntrySlippage,
    exitSlippage:
      totalExitSlippage,

    costs: totalCosts,

    avgTrade: avg,
    medianTrade: med,

    avgHoldHours:
      trades.length
        ? trades.reduce(
            (s, t) =>
              s + t.holdHours,
            0
          ) / trades.length
        : 0,

    maxDrawdown: maxDD,
    profitFactor,

    bestTrade:
      trades.length
        ? Math.max(
            ...trades.map(
              t => t.net
            )
          )
        : 0,

    worstTrade:
      trades.length
        ? Math.min(
            ...trades.map(
              t => t.net
            )
          )
        : 0,

    exits:
      trades.reduce(
        (m, t) => {
          m[t.reason] =
            (m[t.reason] || 0) + 1;
          return m;
        },
        {}
      )
  };
}

function walkForward(
  trades,
  start,
  end
) {
  const trainMs =
    365 * 86400000;

  const testMs =
    90 * 86400000;

  const rows = [];

  let cursor =
    start + trainMs;

  while (
    cursor + testMs <= end
  ) {
    const testStart =
      cursor;

    const testEnd =
      cursor + testMs;

    const tt =
      trades.filter(
        t =>
          t.entryTime >=
            testStart &&
          t.entryTime <
            testEnd
      );

    const net =
      tt.reduce(
        (s, t) =>
          s + t.net,
        0
      );

    rows.push({
      testStart:
        new Date(
          testStart
        ).toISOString(),

      testEnd:
        new Date(
          testEnd
        ).toISOString(),

      trades: tt.length,
      net,

      avgTrade:
        tt.length
          ? net / tt.length
          : 0,

      winRate:
        tt.length
          ? tt.filter(
              t => t.net > 0
            ).length /
            tt.length
          : 0
    });

    cursor =
      testEnd;
  }

  return rows;
}

async function loadSymbol(
  symbol,
  spot,
  start,
  end
) {
  const [
    spotK,
    perpK,
    funding
  ] = await Promise.all([
    getKlines(
      'spot',
      spot,
      start,
      end
    ),

    getKlines(
      'linear',
      symbol,
      start,
      end
    ),

    getFunding(
      symbol,
      start,
      end
    )
  ]);

  if (
    spotK.length < 500 ||
    perpK.length < 500
  ) {
    return null;
  }

  const aligned =
    alignData(
      spotK,
      perpK,
      funding
    );

  if (
    aligned.t.length < 500
  ) {
    return null;
  }

  return aligned;
}

async function runBacktest({
  days = CFG.defaultDays,
  top = CFG.top
} = {}) {
  if (state.running) {
    throw new Error(
      'A backtest is already running.'
    );
  }

  state.running = true;
  state.startedAt =
    new Date().toISOString();

  state.finishedAt = null;
  state.progress = 0;
  state.stage = 'starting';
  state.message = '';
  state.error = null;
  state.report = null;

  try {
    days = Math.max(
      30,
      Math.min(
        730,
        Number(days) ||
          CFG.defaultDays
      )
    );

    top = Math.max(
      5,
      Math.min(
        60,
        Number(top) ||
          CFG.top
      )
    );

    const end =
      nowMs();

    const start =
      end -
      days * 86400000;

    const universe =
      await getUniverse(top);

    if (!universe.length) {
      throw new Error(
        'No symbols matched the liquidity/universe filters.'
      );
    }

    state.stage =
      'symbols';

    state.message =
      'Loading universe for cross-sectional basis-stress filter...';

    const loaded = [];
    const symbolStats = [];

    let completed = 0;

    const queue =
      [...universe];

    const workers =
      Array.from(
        {
          length:
            Math.min(
              CFG.concurrency,
              queue.length
            )
        },
        async () => {
          while (
            queue.length
          ) {
            const u =
              queue.shift();

            state.message =
              `Loading ${u.symbol} (${completed + 1}/${universe.length})...`;

            try {
              const data =
                await loadSymbol(
                  u.symbol,
                  u.spot,
                  start,
                  end
                );

              if (!data) {
                symbolStats.push({
                  symbol:
                    u.symbol,
                  turnover24h:
                    u.turnover24h,
                  skipped: true
                });
              } else {
                loaded.push({
                  u,
                  data
                });

                symbolStats.push({
                  symbol:
                    u.symbol,
                  turnover24h:
                    u.turnover24h,
                  skipped: false
                });
              }
            } catch (err) {
              symbolStats.push({
                symbol:
                  u.symbol,
                turnover24h:
                  u.turnover24h,
                skipped: true,
                error:
                  err.message
              });
            }

            completed++;

            state.progress =
              Math.round(
                (completed /
                  universe.length) *
                  65
              );
          }
        }
      );

    await Promise.all(
      workers
    );

    state.stage =
      'stress-filter';

    state.message =
      'Building cross-sectional market stress filter...';

    const stressCounts =
      new Map();

    const validCounts =
      new Map();

    for (const {
      data
    } of loaded) {
      const bs =
        basisSeries(data);

      for (
        let i = 6;
        i < data.t.length;
        i++
      ) {
        if (
          !Number.isFinite(
            bs[i]
          ) ||
          !Number.isFinite(
            bs[i - 6]
          )
        ) {
          continue;
        }

        const t =
          data.t[i];

        validCounts.set(
          t,
          (validCounts.get(t) ||
            0) + 1
        );

        if (
          bs[i] -
            bs[i - 6] >=
          CFG.marketStressBasisRise6h
        ) {
          stressCounts.set(
            t,
            (stressCounts.get(t) ||
              0) + 1
          );
        }
      }
    }

    const marketStressByTime =
      new Map();

    for (
      const [t, n] of validCounts
    ) {
      const breadth =
        (stressCounts.get(t) ||
          0) / n;

      marketStressByTime.set(
        t,
        breadth >=
          CFG.marketStressBreadth
      );
    }

    const variants = [
      {
        name:
          'v3A_minBasis_0.8pct',
        minBasis:
          0.0080
      },

      {
        name:
          'v3B_minBasis_1.0pct',
        minBasis:
          0.0100
      }
    ];

    const variantReports =
      [];

    for (
      const variant of variants
    ) {
      state.stage =
        'simulation';

      state.message =
        `Simulating ${variant.name}...`;

      const allTrades = [];
      const variantStats = [];

      for (
        const {
          u,
          data
        } of loaded
      ) {
        const trades =
          simulateCoin(
            data,
            u.symbol,
            marketStressByTime,
            variant.minBasis
          );

        allTrades.push(
          ...trades
        );

        variantStats.push({
          symbol:
            u.symbol,
          turnover24h:
            u.turnover24h,
          trades:
            trades.length,
          net:
            trades.reduce(
              (s, t) =>
                s + t.net,
              0
            ),
          skipped: false
        });
      }

      allTrades.sort(
        (a, b) =>
          a.entryTime -
          b.entryTime
      );

      const accepted = [];
      const openUntil = [];
      const openSymbols =
        new Set();

      for (
        const trade of allTrades
      ) {
        for (
          let i =
            openUntil.length - 1;
          i >= 0;
          i--
        ) {
          if (
            openUntil[i]
              .exitTime <=
            trade.entryTime
          ) {
            openSymbols.delete(
              openUntil[i]
                .symbol
            );

            openUntil.splice(
              i,
              1
            );
          }
        }

        if (
          openUntil.length >=
            CFG.maxConcurrent ||
          openSymbols.has(
            trade.symbol
          )
        ) {
          continue;
        }

        accepted.push(
          trade
        );

        openUntil.push({
          symbol:
            trade.symbol,
          exitTime:
            trade.exitTime
        });

        openSymbols.add(
          trade.symbol
        );
      }

      const summary =
        aggregateTrades(
          accepted,
          days,
          universe.map(
            x => x.symbol
          )
        );

      const wf =
        walkForward(
          accepted,
          start,
          end
        );

      variantReports.push({
        name:
          variant.name,
        minBasis:
          variant.minBasis,
        summary,
        walkForward:
          wf,
        symbolStats:
          variantStats.sort(
            (a, b) =>
              b.net - a.net
          ),

        trades:
          accepted.map(
            t => ({
              ...t,
              entryTime:
                new Date(
                  t.entryTime
                ).toISOString(),
              exitTime:
                new Date(
                  t.exitTime
                ).toISOString()
            })
          )
      });
    }

    const report = {
      strategy:
        'BRF v3 - Basis Reversion + Funding Confirmation',

      generatedAt:
        new Date().toISOString(),

      dataWindow: {
        start:
          new Date(
            start
          ).toISOString(),

        end:
          new Date(
            end
          ).toISOString(),

        days
      },

      config: CFG,

      universe: {
        requested: top,
        loaded:
          loaded.length,

        symbols:
          universe.map(
            x => x.symbol
          ),

        minTurnover24h:
          CFG.minTurnover24h
      },

      marketStress: {
        breadthThreshold:
          CFG.marketStressBreadth,

        basisRise6hThreshold:
          CFG.marketStressBasisRise6h
      },

      variants:
        variantReports
    };

    state.progress = 100;
    state.stage =
      'done';

    state.message =
      'Backtest complete.';

    state.report =
      report;

    state.finishedAt =
      new Date().toISOString();

    return report;
  } catch (err) {
    state.stage =
      'error';

    state.error =
      err.stack ||
      err.message;

    state.message =
      err.message;

    state.finishedAt =
      new Date().toISOString();

    throw err;
  } finally {
    state.running =
      false;
  }
}

function html() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>BRF V3 Backtest</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{
  font-family:Arial,sans-serif;
  max-width:1100px;
  margin:30px auto;
  padding:0 16px;
  line-height:1.45
}
button,input{
  padding:10px;
  font-size:16px
}
button{
  cursor:pointer
}
pre{
  background:#111;
  color:#eee;
  padding:16px;
  border-radius:8px;
  overflow:auto
}
.card{
  border:1px solid #ddd;
  border-radius:10px;
  padding:16px;
  margin:12px 0
}
.small{
  color:#666
}
</style>
</head>

<body>
<h1>BRF V3 Backtest</h1>

<p class="small">
Basis Reversion + Funding Confirmation.
Backtest only. No private API keys and no live trading.
</p>

<div class="card">
  <label>
    Days
    <input
      id="days"
      type="number"
      value="${CFG.defaultDays}"
      min="30"
      max="730">
  </label>

  <label>
    Top symbols
    <input
      id="top"
      type="number"
      value="${CFG.top}"
      min="5"
      max="60">
  </label>

  <button onclick="start()">
    Start backtest
  </button>
</div>

<div class="card">
  <div id="status">
    Idle
  </div>

  <div id="error"></div>
</div>

<div class="card">
  <h2>Report</h2>
  <pre id="report">
No report yet.
  </pre>
</div>

<script>
async function start(){
  const days =
    document.getElementById('days').value;

  const top =
    document.getElementById('top').value;

  const r =
    await fetch(
      '/backtest/start?days=' +
      encodeURIComponent(days) +
      '&top=' +
      encodeURIComponent(top)
    );

  const j =
    await r.json();

  document.getElementById(
    'status'
  ).textContent =
    j.message ||
    JSON.stringify(j);

  poll();
}

async function poll(){
  try{
    const r =
      await fetch(
        '/backtest/status',
        {
          cache:'no-store'
        }
      );

    const j =
      await r.json();

    document.getElementById(
      'status'
    ).textContent =
      (j.stage || '') +
      ' | ' +
      (j.message || '') +
      ' | ' +
      (j.progress || 0) +
      '%';

    document.getElementById(
      'error'
    ).textContent =
      j.error || '';

    if(j.report){
      document.getElementById(
        'report'
      ).textContent =
        JSON.stringify(
          j.report,
          null,
          2
        );
    }

    if(j.running){
      setTimeout(
        poll,
        1500
      );
    }
  }catch(err){
    document.getElementById(
      'error'
    ).textContent =
      err.message;

    setTimeout(
      poll,
      3000
    );
  }
}

poll();
</script>
</body>
</html>`;
}

function sendJson(
  res,
  code,
  obj
) {
  const body =
    JSON.stringify(obj);

  res.writeHead(
    code,
    {
      'Content-Type':
        'application/json; charset=utf-8',

      'Cache-Control':
        'no-store'
    }
  );

  res.end(body);
}

const server =
  http.createServer(
    async (
      req,
      res
    ) => {
      try {
        const u =
          new URL(
            req.url,
            `http://${req.headers.host}`
          );

        if (
          u.pathname === '/' ||
          u.pathname ===
            '/index.html'
        ) {
          res.writeHead(
            200,
            {
              'Content-Type':
                'text/html; charset=utf-8'
            }
          );

          res.end(
            html()
          );

          return;
        }

        if (
          u.pathname ===
          '/health'
        ) {
          sendJson(
            res,
            200,
            {
              ok: true,
              running:
                state.running,
              stage:
                state.stage
            }
          );

          return;
        }

        if (
          u.pathname ===
          '/backtest/start'
        ) {
          if (
            state.running
          ) {
            sendJson(
              res,
              409,
              {
                ok: false,
                message:
                  'Backtest already running.'
              }
            );

            return;
          }

          const days =
            Number(
              u.searchParams.get(
                'days'
              ) ||
              CFG.defaultDays
            );

          const top =
            Number(
              u.searchParams.get(
                'top'
              ) ||
              CFG.top
            );

          runBacktest({
            days,
            top
          }).catch(
            () => {}
          );

          sendJson(
            res,
            202,
            {
              ok: true,

              message:
                `Backtest started: ${days} days, top ${top}.`,

              status:
                '/backtest/status'
            }
          );

          return;
        }

        if (
          u.pathname ===
          '/backtest/status'
        ) {
          sendJson(
            res,
            200,
            {
              running:
                state.running,

              startedAt:
                state.startedAt,

              finishedAt:
                state.finishedAt,

              progress:
                state.progress,

              stage:
                state.stage,

              message:
                state.message,

              error:
                state.error,

              report:
                state.report
                  ? {
                      summary:
                        state.report
                          .variants
                          ?.map(
                            v => ({
                              name:
                                v.name,
                              summary:
                                v.summary
                            })
                          ),

                      dataWindow:
                        state.report
                          .dataWindow
                    }
                  : null
            }
          );

          return;
        }

        if (
          u.pathname ===
          '/backtest/report'
        ) {
          if (
            !state.report
          ) {
            sendJson(
              res,
              404,
              {
                ok: false,
                message:
                  'No completed report yet.'
              }
            );

            return;
          }

          sendJson(
            res,
            200,
            state.report
          );

          return;
        }

        sendJson(
          res,
          404,
          {
            ok: false,
            message:
              'Not found'
          }
        );
      } catch (err) {
        sendJson(
          res,
          500,
          {
            ok: false,
            error:
              err.message
          }
        );
      }
    }
  );

server.listen(
  PORT,
  () => {
    console.log(
      `BRF V3 backtest server listening on port ${PORT}`
    );

    console.log(
      `Open http://localhost:${PORT}/`
    );
  }
);
"""

path = Path("/mnt/data/server.js")
path.write_text(code, encoding="utf-8")
print(f"Created: {path}")
