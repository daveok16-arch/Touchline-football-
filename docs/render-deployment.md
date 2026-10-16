# Deploying Project Touchline to Render

This gives the app a permanent public URL you can check at any time.

## Live service

| | |
|---|---|
| URL | https://touchline-football.onrender.com |
| Service | `Touchline-football-` (`srv-db936o8n74is73dbhe6g`) |
| Runtime | Docker (`./Dockerfile`), region `oregon`, free plan |
| Auto-deploy | on push to `main` |
| Health check | `/api/status` |

## What runs

A single container that installs dependencies, builds the Vite client bundle,
and serves it together with the Express API from `server.ts` via `tsx`. Render
injects `PORT`; `server.ts` reads it (falling back to 3000 locally).

## Prerequisites

- A Render account (free tier is enough).
- A football-data.org token for `FOOTBALL_DATA_API_KEY`
  (https://www.football-data.org/client/register).

## Deploy from scratch

1. In Render, choose **New + → Blueprint** and select this repository.
2. Render reads `render.yaml` and creates the `Touchline-football-` web service.
3. When prompted, paste the value for `FOOTBALL_DATA_API_KEY`. This is the only
   required secret. It is stored by Render and never committed to the repo.
4. Deploy. Render builds the image (`Dockerfile`: `npm install --include=dev`
   then `npm run build`) and starts `npm start` (`tsx server.ts`), with a health
   check on `/api/status`.

Your stable URL is shown on the service page
(`https://touchline-football.onrender.com`).

## Fixing a failed build

If a build fails with `npm error code ERESOLVE`, a dependency's declared version
range conflicts with a peer requirement. Bump the offending package rather than
adding `--legacy-peer-deps`, then confirm with a clean install:

```
rm -rf node_modules && npm ci --include=dev && npm run build
```

`package-lock.json` is committed, so `npm ci` is reproducible.

## Optional settings

Add any of these in the Render dashboard if you want them. All research flags
stay `false` unless you deliberately turn them on.

| Variable | Purpose |
|---|---|
| `SPORTAPI_KEY` | sportapi.ai free tier (cup competitions) |
| `FIVE_DOLLAR_KEY` | 5dollarfootballapi.com free tier (odds markets) |
| `ODDS_API_KEY` | the-odds-api.com (kept off unless `ENABLE_ODDS_API=true`) |
| `ENABLE_ODDS_API` | must be exactly `"true"` to enable metered odds calls |
| `ODDS_MONTHLY_REQUEST_BUDGET` | local cap, defaults to `300` |

## Free-tier caveats

- Render's free web service sleeps after ~15 minutes of inactivity. The next
  visit triggers a cold start that takes ~30–60 seconds. A paid instance removes
  this, and a periodic health check against `/api/status` can keep it warm.
- In-memory caches reset on restart. Nothing here needs durable disk.

## Local production check

```
npm ci --include=dev
npm run build
NODE_ENV=production PORT=4000 npm start
curl -s localhost:4000/api/status
```

