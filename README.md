# BRF v1 Bybit Backtest

This is a backtest-only Node.js service.

It does not place orders and does not require Bybit API keys.

## Deploy on Render

1. Put `server.js`, `package.json`, and `render.yaml` in a GitHub repo.
2. Create a Render Web Service from the repo.
3. Build command:
   `npm install`
4. Start command:
   `node server.js`
5. Open the Render URL.
6. Use:
   `/backtest/start?days=730&top=35`
7. Poll:
   `/backtest/status`
8. When complete, download/read:
   `/backtest/report`

## Strategy

Long spot + short USDT perpetual.

Entry:
- 14-day rolling basis z-score >= 2
- basis >= 0.50%
- 3-day annualized funding >= 5%
- 7-day annualized funding >= 3%
- short funding >= 70% of long funding
- no BTC 24h stress below -4%
- expected edge must clear a trading-cost buffer

Exit:
- basis z-score <= 0.50
- funding collapses
- basis z-score >= 3.50
- maximum 72 hours
- end of test

## Important

The default costs are deliberately conservative:
- spot fee 0.10%
- perp fee 0.055%
- slippage 0.04% per leg

Change them with environment variables before comparing results.

Example:
`SLIPPAGE=0.0002`

Do not compare this to another backtest unless the data window, universe, fees, slippage, execution assumptions, and position sizing are the same.

## Useful environment variables

- DAYS=730
- TOP=35
- ENTRY_Z=2
- MIN_BASIS=0.005
- EXIT_Z=0.5
- STOP_Z=3.5
- MAX_HOLD_HOURS=72
- MIN_FUNDING_3D_ANN=0.05
- MIN_FUNDING_7D_ANN=0.03
- FUNDING_STABILITY=0.70
- SPOT_FEE=0.001
- PERP_FEE=0.00055
- SLIPPAGE=0.0004
- MAX_CONCURRENT=5
- MIN_TURNOVER_24H=50000000
