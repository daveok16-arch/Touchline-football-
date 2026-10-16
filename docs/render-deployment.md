# Deploying Project Touchline to Render

This gives the app a permanent public URL you can check at any time.

## What runs

One Node web service that builds the Vite client bundle and serves it together
with the Express API from `server.ts`. Render injects `PORT`; `server.ts` reads it.

## Prerequisites

- A Render account (free tier is enough).
- A football-data.org token for `FOOTBALL_DATA_API_KEY`
  (https://www.football-data.org/client/register).

## Deploy

1. In Render, choose **New + → Blueprint** and select this repository.
2. Render reads `render.yaml` and creates the `project-touchline` web service.
3. When prompted, paste the value for `FOOTBALL_DATA_API_KEY`. This is the only
   required secret. It is stored by Render and never committed to the repo.
4. Deploy. Render runs:

   - Build: `npm ci --include=dev && npm run build`
   - Start: `npm start` (`tsx server.ts`)
   - Health check: `/api/status`

Your stable URL is shown on the service page
(`https://<service-name>.onrender.com`).

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
npm install
npm run build
NODE_ENV=production PORT=4000 npm start
curl -s localhost:4000/api/status
```
