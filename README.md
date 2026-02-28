# Bitget Futures Demo Trading

Demo trading simulator for Bitget futures with profile-based login and per-user saved state.

## Run Locally

```powershell
python server.py
```

Open: `http://127.0.0.1:8000`

Account data is now saved server-side in `data/accounts.json` (created automatically).

## Deploy To GitHub + Cloudflare Pages

1. Push this folder to a GitHub repo.
2. In Cloudflare Dashboard, create a new **Pages** project from that repo.
3. Build settings:
   - Framework preset: `None`
   - Build command: *(empty)*
   - Build output directory: `/`
4. Deploy.

This repo already includes a Pages Function at `functions/api/bitget/[[path]].js` that proxies Bitget REST requests from `/api/bitget/*`, so the app works in browser environments like iPhone/iPad Safari and Chrome without running `server.py`.

## Key Features

- Supports `USDT-FUTURES`, `COIN-FUTURES`, `USDC-FUTURES`.
- Real-time ticker updates via Bitget public WebSocket.
- REST fallback refresh every 20 seconds.
- Long/short simulation, leverage clamp, estimated liquidation, funding + fee impact.
- TP/SL + manual/limit close.
- Login/register/logout in browser.
- Each login profile stores its own:
  - open positions
  - closed history
  - realized PnL / account balance state

## Timestamp Accuracy Fix

TP/SL/limit/liquidation close time now uses ticker timestamps with crossing-time interpolation between the previous and current price tick. This prevents close time from being recorded as app-restart time when the trigger occurred earlier.

## Mobile / iPad Optimizations

- Touch-friendly input/button sizes.
- Safe-area aware layout (`viewport-fit=cover`).
- Smooth horizontal table scrolling on Safari (`-webkit-overflow-scrolling: touch`).
- Trading panels lock when not logged in.

## Important Note

- Credentials are now stored as salted PBKDF2 hashes in the local server database (`data/accounts.json`).
- Session token is stored in browser localStorage to keep you logged in between page refreshes.
- This is a simulator, not real order execution.
