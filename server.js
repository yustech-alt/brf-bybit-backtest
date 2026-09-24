
'use strict';

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
  minBasis: Number(process.env.MIN_BASIS || 0.008),
  exitZ: Number(process.env.EXIT_Z || 0.50),
  stopZ: Number(process.env.STOP_Z || 4.0),
  maxHoldHours: Number(process.env.MAX_HOLD_HOURS || 72),

  fundingShortHours: Number(process.env.FUNDING_SHORT_HOURS || 72),
  fundingLongHours: Number(process.env.FUNDING_LONG_HOURS || 168),
  minFunding3dAnn: Number(process.env.MIN_FUNDING_3D_ANN || 0.05),
  minFunding7dAnn: Number(process.env.MIN_FUNDING_7D_ANN || 0.03),
  fundingStability: Number(process.env.FUNDING_STABILITY || 0.70),

  spotFee: Number(process.env.SPOT_FEE || 0.001),
  perpFee: Number(process.env.PERP_FEE || 0.00055),
  slippage: Number(process.env.SLIPPAGE || 0.00040),

  minNetEdgeMultiple: Number(process.env.MIN_NET_EDGE_MULTIPLE || 1.0),
  minTurnover24h: Number(process.env.MIN_TURNOVER_24H || 10000000),
  marketStressBreadth: Number(process.env.MARKET_STRESS_BREADTH || 0.50),
  marketStressBasisRise6h: Number(process.env.MARKET_STRESS_BASIS_RISE_6H || 0.0025),
  adverseBasisFloor: Number(process.env.ADVERSE_BASIS_FLOOR || 0.005),
  adverseZExtra: Number(process.env.ADVERSE_Z_EXTRA || 2.0),

  klineLimit: 1000,
  fundingLimit: 200,
  requestDelayMs: Number(process.env.REQUEST_DELAY_MS || 80),
  concurrency: Number(process.env.CONCURRENCY || 4),
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 20000)
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

async function api(path, params = {}, attempt = 0) {
  const url = new URL(API + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CFG.requestTimeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    }

    const json = JSON.parse(text);

    if (json.retCode !== 0) {
      throw new Error(`Bybit ${json.retCode}: ${json.retMsg || 'request failed'}`);
    }

    return json;
  } catch (error) {
    if (attempt < 3) {
      await sleep(500 * (attempt + 1));
      return api(path, params, attempt + 1);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function getInstruments(category) {
  const rows = [];
  let cursor = '';

  do {
    const result = await api('/v5/market/instruments-info', {
      category,
      limit: 1000,
      cursor
    });

    rows.push(...(result.result?.list || []));
    cursor = result.result?.nextPageCursor || '';
  } while (cursor);

  return rows;
}

async function getTickers(category) {
  const result = await api('/v5/market/tickers', { category });
  return result.result?.list || [];
}

async function getUniverse(top) {
  const [linear, spot, tickers] = await Promise.all([
    getInstruments('linear'),
    getInstruments('spot'),
    getTickers('linear')
  ]);

  const spotSet = new Set(
    spot
      .filter(x => x.status === 'Trading' && x.quoteCoin === 'USDT')
      .map(x => x.symbol)
  );

  const turnover = new Map(
    tickers.map(x => [x.symbol, Number(x.turnover24h || 0)])
  );

  return linear
    .filter(x =>
      x.status === 'Trading' &&
      x.contractType === 'LinearPerpetual' &&
      x.quoteCoin === 'USDT' &&
      spotSet.has(`${x.baseCoin}USDT`) &&
      (turnover.get(x.symbol) || 0) >= CFG.minTurnover24h
    )
    .sort((a, b) =>
      (turnover.get(b.symbol) || 0) - (turnover.get(a.symbol) || 0)
    )
    .slice(0, top)
    .map(x => ({
      symbol: x.symbol,
      spotSymbol: `${x.baseCoin}USDT`,
      turnover24h: turnover.get(x.symbol) || 0
    }));
}

async function getKlines(category, symbol, start, end) {
  const rows = [];
  let cursorEnd = end;

  while (cursorEnd > start) {
    const result = await api('/v5/market/kline', {
      category,
      symbol,
      interval: CFG.interval,
      start,
      end: cursorEnd,
      limit: CFG.klineLimit
    });

    const list = result.result?.list || [];
    if (!list.length) break;

    for (const row of list) {
      const t = Number(row[0]);
      if (t >= start && t <= end) {
        rows.push({
          t,
          open: Number(row[1]),
          high: Number(row[2]),
          low: Number(row[3]),
          close: Number(row[4])
        });
      }
    }

    const oldest = Math.min(...list.map(row => Number(row[0])));
    if (!Number.isFinite(oldest) || oldest <= start) break;

    cursorEnd = oldest - 1;
    await sleep(CFG.requestDelayMs);
  }

  return rows.sort((a, b) => a.t - b.t);
}

async function getFunding(symbol, start, end) {
  const rows = [];
  let cursorEnd = end;

  while (cursorEnd > start) {
    const result = await api('/v5/market/funding/history', {
      category: 'linear',
      symbol,
      startTime: start,
      endTime: cursorEnd,
      limit: CFG.fundingLimit
    });

    const list = result.result?.list || [];
    if (!list.length) break;

    for (const row of list) {
      const t = Number(row.fundingRateTimestamp);
      if (t >= start && t <= end) {
        rows.push({
          t,
          rate: Number(row.fundingRate)
        });
      }
    }

    const oldest = Math.min(
      ...list.map(row => Number(row.fundingRateTimestamp))
    );

    if (!Number.isFinite(oldest) || oldest <= start) break;

    cursorEnd = oldest - 1;
    await sleep(CFG.requestDelayMs);
  }

  return rows.sort((a, b) => a.t - b.t);
}

function rollingMeanStd(values, endIndex, lookback) {
  const start = Math.max(0, endIndex - lookback + 1);
  const valuesInWindow = values
    .slice(start, endIndex + 1)
    .filter(Number.isFinite);

  if (valuesInWindow.length < lookback) return null;

  const mean =
    valuesInWindow.reduce((sum, value) => sum + value, 0) /
    valuesInWindow.length;

  const variance =
    valuesInWindow.reduce(
      (sum, value) => sum + (value - mean) ** 2,
      0
    ) / valuesInWindow.length;

  return {
    mean,
    std: Math.sqrt(variance)
  };
}

function basisSeries(perp, spot) {
  const spotMap = new Map(spot.map(candle => [candle.t, candle.close]));

  return perp.map(candle => {
    const spotClose = spotMap.get(candle.t);
    return spotClose > 0 ? candle.close / spotClose - 1 : NaN;
  });
}

function fundingWindow(events, endTime, hours) {
  const startTime = endTime - hours * 3600000;

  const rows = events.filter(
    event => event.t > startTime && event.t <= endTime
  );

  const sum = rows.reduce((total, event) => total + event.rate, 0);

  return {
    sum,
    count: rows.length,
    annualized: sum * (24 * 365 / hours)
  };
}

function fundingForecast(events, endTime) {
  const short = fundingWindow(
    events,
    endTime,
    CFG.fundingShortHours
  );

  const long = fundingWindow(
    events,
    endTime,
    CFG.fundingLongHours
  );

  const shortHourly = short.sum / CFG.fundingShortHours;
  const longHourly = long.sum / CFG.fundingLongHours;

  return {
    short,
    long,
    conservativeHourly: Math.max(
      0,
      Math.min(shortHourly, longHourly)
    )
  };
}

function oneWayCost() {
  return CFG.spotFee + CFG.perpFee + 2 * CFG.slippage;
}

function roundTripCost() {
  return 2 * oneWayCost();
}

function tradePnl({ entry, exit, entryBasis, exitBasis, fundingEvents }) {
  // Approximation of the paired spot/perp basis trade P&L.
  // Funding is calculated only from actual settlement timestamps.
  const spotGross =
    (1 / (1 + entryBasis)) -
    (1 / (1 + exitBasis));

  const perpGross =
    ((1 + entryBasis) / (1 + exitBasis)) - 1;

  const funding = fundingEvents
    .filter(event => event.t > entry.t && event.t <= exit.t)
    .reduce((sum, event) => sum + event.rate, 0);

  const fees = 2 * (CFG.spotFee + CFG.perpFee);
  const slippage = 4 * CFG.slippage;
  const gross = spotGross + perpGross + funding;
  const net = gross - fees - slippage;

  return {
    spotGross,
    perpGross,
    funding,
    fees,
    slippage,
    gross,
    net
  };
}

function createDiagnostics() {
  return {
    barsChecked: 0,
    stressReject: 0,
    zReject: 0,
    basisReject: 0,
    fundingReject: 0,
    stabilityReject: 0,
    edgeReject: 0,
    accepted: 0
  };
}

function simulateCoin(data, minimumBasis) {
  const { candles, basis, fundingEvents, marketStress } = data;
  const trades = [];
  const diagnostics = createDiagnostics();

  let openTrade = null;

  const startIndex =
    CFG.basisLookbackHours +
    CFG.fundingLongHours +
    24;

  for (let i = startIndex; i < candles.length - 1; i++) {
    diagnostics.barsChecked++;

    if (openTrade) {
      const candle = candles[i];
      const holdHours =
        (candle.t - openTrade.entry.t) / 3600000;

      const stats = rollingMeanStd(
        basis,
        i,
        CFG.basisLookbackHours
      );

      if (!stats) continue;

      const z =
        stats.std > 0
          ? (basis[i] - stats.mean) / stats.std
          : 0;

      const funding = fundingForecast(
        fundingEvents,
        candle.t
      );

      const fundingCollapse =
        funding.short.annualized <= 0 ||
        funding.short.annualized <=
          openTrade.entryFunding3d * 0.25;

      const adverseBasis =
        basis[i] >= Math.max(
          CFG.adverseBasisFloor,
          openTrade.entryBasis + 0.0025
        );

      const hardStop = z >= CFG.stopZ;
      const adverseZ =
        z >= openTrade.entryZ + CFG.adverseZExtra;

      let exitReason = null;

      if (holdHours >= CFG.maxHoldHours) {
        exitReason = 'max_hold';
      } else if (hardStop || adverseZ || adverseBasis) {
        exitReason = 'adverse_basis';
      } else if (
        holdHours >= CFG.minHoldHours &&
        z <= CFG.exitZ
      ) {
        exitReason = 'basis_convergence';
      } else if (
        holdHours >= CFG.minHoldHours &&
        fundingCollapse
      ) {
        exitReason = 'funding_collapse';
      }

      if (exitReason) {
        const exit = candles[i + 1];

        const pnl = tradePnl({
          entry: openTrade.entry,
          exit,
          entryBasis: openTrade.entryBasis,
          exitBasis: basis[i],
          fundingEvents
        });

        trades.push({
          symbol: data.symbol,
          entryTime: openTrade.entry.t,
          exitTime: exit.t,
          holdHours:
            (exit.t - openTrade.entry.t) / 3600000,
          entryBasis: openTrade.entryBasis,
          exitBasis: basis[i],
          entryZ: openTrade.entryZ,
          exitZ: z,
          entryFunding3d: openTrade.entryFunding3d,
          entryFunding7d: openTrade.entryFunding7d,
          ...pnl,
          exitReason
        });

        openTrade = null;
      }

      continue;
    }

    if (marketStress[i]) {
      diagnostics.stressReject++;
      continue;
    }

    const stats = rollingMeanStd(
      basis,
      i,
      CFG.basisLookbackHours
    );

    if (!stats || stats.std <= 0) continue;

    const z = (basis[i] - stats.mean) / stats.std;

    if (z < CFG.entryZ) {
      diagnostics.zReject++;
      continue;
    }

    if (basis[i] < minimumBasis) {
      diagnostics.basisReject++;
      continue;
    }

    const funding = fundingForecast(
      fundingEvents,
      candles[i].t
    );

    if (
      funding.short.annualized < CFG.minFunding3dAnn ||
      funding.long.annualized < CFG.minFunding7dAnn
    ) {
      diagnostics.fundingReject++;
      continue;
    }

    if (
      funding.short.annualized <
      funding.long.annualized * CFG.fundingStability
    ) {
      diagnostics.stabilityReject++;
      continue;
    }

    const expectedBasis =
      Math.max(0, basis[i] - stats.mean);

    const expectedFunding =
      funding.conservativeHourly *
      CFG.maxHoldHours;

    const expectedEdge =
      expectedBasis + expectedFunding;

    const requiredEdge =
      roundTripCost() *
      (1 + CFG.minNetEdgeMultiple);

    if (expectedEdge < requiredEdge) {
      diagnostics.edgeReject++;
      continue;
    }

    diagnostics.accepted++;

    // Signal at candle i, execute at next candle open.
    openTrade = {
      entry: candles[i + 1],
      entryBasis: basis[i],
      entryZ: z,
      entryFunding3d: funding.short.annualized,
      entryFunding7d: funding.long.annualized
    };
  }

  if (openTrade) {
    const i = candles.length - 1;
    const exit = candles[i];

    const pnl = tradePnl({
      entry: openTrade.entry,
      exit,
      entryBasis: openTrade.entryBasis,
      exitBasis: basis[i],
      fundingEvents
    });

    trades.push({
      symbol: data.symbol,
      entryTime: openTrade.entry.t,
      exitTime: exit.t,
      holdHours:
        (exit.t - openTrade.entry.t) / 3600000,
      entryBasis: openTrade.entryBasis,
      exitBasis: basis[i],
      entryZ: openTrade.entryZ,
      exitZ: null,
      entryFunding3d: openTrade.entryFunding3d,
      entryFunding7d: openTrade.entryFunding7d,
      ...pnl,
      exitReason: 'end_of_data'
    });
  }

  return { trades, diagnostics };
}

function aggregateTrades(trades) {
  const net = trades.reduce(
    (sum, trade) => sum + trade.net,
    0
  );

  const wins = trades.filter(trade => trade.net > 0);
  const losses = trades.filter(trade => trade.net <= 0);

  const grossProfit = wins.reduce(
    (sum, trade) => sum + trade.net,
    0
  );

  const grossLoss = Math.abs(
    losses.reduce((sum, trade) => sum + trade.net, 0)
  );

  const ordered = [...trades].sort(
    (a, b) => a.exitTime - b.exitTime
  );

  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;

  for (const trade of ordered) {
    equity += trade.net;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(
      maxDrawdown,
      peak - equity
    );
  }

  const holds = trades.map(
    trade => trade.holdHours
  );

  const sortedHolds = [...holds].sort(
    (a, b) => a - b
  );

  let medianHold = 0;

  if (sortedHolds.length) {
    const middle = Math.floor(
      sortedHolds.length / 2
    );

    medianHold =
      sortedHolds.length % 2
        ? sortedHolds[middle]
        : (
            sortedHolds[middle - 1] +
            sortedHolds[middle]
          ) / 2;
  }

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length
      ? wins.length / trades.length
      : 0,
    net,
    grossProfit,
    grossLoss,
    profitFactor:
      grossLoss > 0
        ? grossProfit / grossLoss
        : null,
    maxDrawdown,
    averageTrade:
      trades.length
        ? net / trades.length
        : 0,
    averageHoldHours:
      holds.length
        ? holds.reduce((a, b) => a + b, 0) /
          holds.length
        : 0,
    medianHoldHours: medianHold,
    funding: trades.reduce(
      (sum, trade) => sum + trade.funding,
      0
    ),
    basisGross: trades.reduce(
      (sum, trade) =>
        sum + trade.spotGross + trade.perpGross,
      0
    ),
    fees: trades.reduce(
      (sum, trade) => sum + trade.fees,
      0
    ),
    slippage: trades.reduce(
      (sum, trade) => sum + trade.slippage,
      0
    ),
    exitReasons: trades.reduce(
      (result, trade) => {
        result[trade.exitReason] =
          (result[trade.exitReason] || 0) + 1;
        return result;
      },
      {}
    )
  };
}

async function loadSymbol(item, start, end) {
  const [spot, perp, fundingEvents] =
    await Promise.all([
      getKlines(
        'spot',
        item.spotSymbol,
        start,
        end
      ),
      getKlines(
        'linear',
        item.symbol,
        start,
        end
      ),
      getFunding(
        item.symbol,
        start,
        end
      )
    ]);

  if (
    spot.length < 500 ||
    perp.length < 500
  ) {
    return null;
  }

  const spotMap = new Map(
    spot.map(candle => [candle.t, candle])
  );

  const candles = perp.filter(
    candle => spotMap.has(candle.t)
  );

  const alignedSpot = candles.map(
    candle => spotMap.get(candle.t)
  );

  return {
    symbol: item.symbol,
    candles,
    basis: basisSeries(
      candles,
      alignedSpot
    ),
    fundingEvents,
    marketStress:
      new Array(candles.length).fill(false)
  };
}

function calculateMarketStress(datasets) {
  const byTime = new Map();

  for (const data of datasets) {
    for (
      let i = 6;
      i < data.candles.length;
      i++
    ) {
      const time = data.candles[i].t;
      const rise =
        data.basis[i] -
        data.basis[i - 6];

      if (!byTime.has(time)) {
        byTime.set(time, []);
      }

      byTime.get(time).push(rise);
    }
  }

  for (const data of datasets) {
    for (
      let i = 6;
      i < data.candles.length;
      i++
    ) {
      const rises =
        byTime.get(data.candles[i].t) || [];

      if (!rises.length) continue;

      const breadth =
        rises.filter(
          rise =>
            rise >=
            CFG.marketStressBasisRise6h
        ).length / rises.length;

      data.marketStress[i] =
        breadth >= CFG.marketStressBreadth;
    }
  }
}

async function mapLimit(
  items,
  limit,
  worker
) {
  const result = new Array(items.length);
  let next = 0;

  async function runner() {
    while (true) {
      const index = next++;

      if (index >= items.length) return;

      try {
        result[index] =
          await worker(
            items[index],
            index
          );
      } catch (error) {
        result[index] = {
          error: error.message
        };
      }
    }
  }

  await Promise.all(
    Array.from(
      {
        length:
          Math.min(
            limit,
            items.length
          )
      },
      runner
    )
  );

  return result;
}

async function runBacktest(
  days,
  top
) {
  state.stage = 'universe';
  state.progress = 2;
  state.message =
    'Loading Bybit market universe...';

  const universe =
    await getUniverse(top);

  const end = Date.now();
  const start =
    end -
    days * 86400000;

  state.stage = 'data';
  state.progress = 5;
  state.message =
    `Loading ${universe.length} symbols...`;

  let completed = 0;

  const results = await mapLimit(
    universe,
    CFG.concurrency,
    async item => {
      const data =
        await loadSymbol(
          item,
          start,
          end
        );

      completed++;

      state.progress =
        5 +
        Math.round(
          (completed /
            Math.max(
              1,
              universe.length
            )) *
            55
        );

      state.message =
        `Loaded ${completed}/${universe.length} symbols`;

      return data;
    }
  );

  const loaded =
    results.filter(
      result =>
        result &&
        !result.error
    );

  calculateMarketStress(loaded);

  const variants = [
    {
      name: 'BRF-V3A',
      minBasis: 0.008
    },
    {
      name: 'BRF-V3B',
      minBasis: 0.010
    }
  ];

  const variantReports = [];

  for (
    let variantIndex = 0;
    variantIndex <
    variants.length;
    variantIndex++
  ) {
    const variant =
      variants[variantIndex];

    state.stage =
      'simulation';

    state.progress =
      60 +
      Math.round(
        (variantIndex /
          variants.length) *
          25
      );

    state.message =
      `Running ${variant.name}...`;

    let allTrades = [];
    const diagnostics =
      createDiagnostics();

    for (const data of loaded) {
      const result =
        simulateCoin(
          data,
          variant.minBasis
        );

      allTrades.push(
        ...result.trades
      );

      for (
        const [key, value] of
        Object.entries(
          result.diagnostics
        )
      ) {
        diagnostics[key] += value;
      }
    }

    allTrades.sort(
      (a, b) =>
        a.entryTime -
        b.entryTime
    );

    // Portfolio concurrency and one-trade-per-symbol rule.
    const selected = [];
    const active = [];

    for (const trade of allTrades) {
      while (
        active.length &&
        active[0].exitTime <=
          trade.entryTime
      ) {
        active.shift();
      }

      if (
        active.length >=
        CFG.maxConcurrent
      ) {
        continue;
      }

      if (
        active.some(
          activeTrade =>
            activeTrade.symbol ===
            trade.symbol
        )
      ) {
        continue;
      }

      selected.push(trade);
      active.push(trade);

      active.sort(
        (a, b) =>
          a.exitTime -
          b.exitTime
      );
    }

    variantReports.push({
      name: variant.name,
      minBasis: variant.minBasis,
      summary:
        aggregateTrades(
          selected
        ),
      diagnostics,
      trades: selected
    });
  }

  state.stage = 'complete';
  state.progress = 100;
  state.message =
    'Backtest complete';

  return {
    strategy: 'BRF V3',
    mode: 'backtest-only',
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
    universe: {
      requested: top,
      loaded:
        loaded.length
    },
    config: {
      entryZ: CFG.entryZ,
      minBasis: CFG.minBasis,
      exitZ: CFG.exitZ,
      stopZ: CFG.stopZ,
      maxHoldHours:
        CFG.maxHoldHours,
      maxConcurrent:
        CFG.maxConcurrent,
      roundTripCost:
        roundTripCost()
    },
    variants:
      variantReports
  };
}

function sendJson(
  response,
  status,
  payload
) {
  const body =
    JSON.stringify(payload);

  response.writeHead(
    status,
    {
      'Content-Type':
        'application/json',
      'Cache-Control':
        'no-store'
    }
  );

  response.end(body);
}

function renderHtml() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BRF V3 Research Backtest</title>
<style>
body{font-family:Arial,sans-serif;max-width:1100px;margin:40px auto;padding:0 20px}
button,input{padding:9px;margin:4px}
pre{background:#111;color:#eee;padding:16px;border-radius:8px;overflow:auto}
.card{border:1px solid #ddd;border-radius:10px;padding:16px;margin-top:16px}
</style>
</head>
<body>
<h1>BRF V3 Research Backtest</h1>
<p>Backtest only. No live trading.</p>

<div class="card">
<label>Days
<input id="days" type="number"
value="${CFG.defaultDays}"
min="30" max="730">
</label>

<label>Top
<input id="top" type="number"
value="${CFG.top}"
min="5" max="100">
</label>

<button onclick="start()">
Run Backtest
</button>
</div>

<div class="card">
<strong>Status</strong>
<div id="status">Idle</div>
</div>

<div class="card">
<strong>Report</strong>
<pre id="report">No report yet.</pre>
</div>

<script>
async function start(){
  const days =
    document.getElementById('days').value;

  const top =
    document.getElementById('top').value;

  const response =
    await fetch(
      '/backtest/start?days=' +
      days +
      '&top=' +
      top
    );

  const result =
    await response.json();

  document.getElementById(
    'status'
  ).textContent =
    result.message ||
    JSON.stringify(result);

  poll();
}

async function poll(){
  const response =
    await fetch(
      '/backtest/status'
    );

  const result =
    await response.json();

  document.getElementById(
    'status'
  ).textContent =
    (result.stage || '') +
    ' | ' +
    (result.message || '') +
    ' | ' +
    (result.progress || 0) +
    '%';

  if(result.report){
    document.getElementById(
      'report'
    ).textContent =
      JSON.stringify(
        result.report,
        null,
        2
      );
  }

  if(result.running){
    setTimeout(
      poll,
      1500
    );
  }
}

poll();
</script>
</body>
</html>`;
}

const server =
  http.createServer(
    async (request, response) => {
      try {
        const url =
          new URL(
            request.url,
            `http://${request.headers.host}`
          );

        if (
          url.pathname === '/'
        ) {
          response.writeHead(
            200,
            {
              'Content-Type':
                'text/html; charset=utf-8'
            }
          );

          return response.end(
            renderHtml()
          );
        }

        if (
          url.pathname ===
          '/health'
        ) {
          return sendJson(
            response,
            200,
            {
              ok: true,
              strategy:
                'BRF V3',
              running:
                state.running
            }
          );
        }

        if (
          url.pathname ===
          '/backtest/start'
        ) {
          if (state.running) {
            return sendJson(
              response,
              409,
              {
                ok: false,
                message:
                  'Backtest already running'
              }
            );
          }

          const days =
            Math.min(
              730,
              Math.max(
                30,
                Number(
                  url.searchParams.get(
                    'days'
                  ) ||
                  CFG.defaultDays
                )
              )
            );

          const top =
            Math.min(
              100,
              Math.max(
                5,
                Number(
                  url.searchParams.get(
                    'top'
                  ) ||
                  CFG.top
                )
              )
            );

          state.running =
            true;

          state.startedAt =
            new Date().toISOString();

          state.finishedAt =
            null;

          state.progress = 0;
          state.stage =
            'starting';

          state.message =
            'Starting BRF V3 backtest';

          state.report = null;
          state.error = null;

          runBacktest(
            days,
            top
          )
            .then(report => {
              state.report =
                report;

              state.running =
                false;

              state.finishedAt =
                new Date().toISOString();
            })
            .catch(error => {
              state.running =
                false;

              state.stage =
                'error';

              state.error =
                error.stack ||
                error.message;

              state.message =
                error.message;
            });

          return sendJson(
            response,
            202,
            {
              ok: true,
              message:
                'Backtest started',
              days,
              top
            }
          );
        }

        if (
          url.pathname ===
          '/backtest/status'
        ) {
          return sendJson(
            response,
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
                      strategy:
                        state.report.strategy,
                      mode:
                        state.report.mode,
                      dataWindow:
                        state.report.dataWindow,
                      universe:
                        state.report.universe,
                      config:
                        state.report.config,
                      variants:
                        state.report.variants.map(
                          variant => ({
                            name:
                              variant.name,
                            minBasis:
                              variant.minBasis,
                            summary:
                              variant.summary,
                            diagnostics:
                              variant.diagnostics
                          })
                        )
                    }
                  : null
            }
          );
        }

        if (
          url.pathname ===
          '/backtest/report'
        ) {
          if (!state.report) {
            return sendJson(
              response,
              404,
              {
                ok: false,
                message:
                  'No completed report'
              }
            );
          }

          return sendJson(
            response,
            200,
            state.report
          );
        }

        return sendJson(
          response,
          404,
          {
            ok: false,
            message:
              'Not found'
          }
        );
      } catch (error) {
        return sendJson(
          response,
          500,
          {
            ok: false,
            error:
              error.stack ||
              error.message
          }
        );
      }
    }
  );

server.listen(
  PORT,
  () => {
    console.log(
      `BRF V3 research server listening on ${PORT}`
    );
  }
);
