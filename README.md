# Project Touchline — Football Intelligence

Responsive football intelligence app: live fixtures, league standings, and Poisson-based
match probability rankings for the top European competitions.

## Stack

React 19 · Vite 8 · TypeScript · Express 4 · Tailwind 4. Single Node process serves both the
JSON API and the built client bundle.

## Requirements

- Node.js >= 20 (the container image uses 22)
- A [football-data.org](https://www.football-data.org/) API key (free tier is sufficient)

## Setup

```bash
npm ci
cp .env.example .env      # then fill in FOOTBALL_DATA_API_KEY
npm run dev               # http://localhost:3000
```

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `FOOTBALL_DATA_API_KEY` | Yes | Primary fixtures/standings provider. Without it the API returns an unconfigured status and no fixtures. |
| `PORT` | No | Listen port. Defaults to 3000; Render injects its own. |
| `SPORTAPI_KEY` | No | Secondary provider, used for match detail lookups. |
| `FIVE_DOLLAR_KEY` | No | Tertiary provider. |
| `ODDS_API_KEY` | No | The Odds API. Only consulted when `ENABLE_ODDS_API=true`. |
| `ENABLE_ODDS_API` | No | Defaults to false. The only feature flag the running app reads. |
| `ODDS_MONTHLY_REQUEST_BUDGET` | No | Local odds request cap. Defaults to 300. |

`ENABLE_PROBABILITY_CALIBRATION` and `ENABLE_SHADOW_CALIBRATION_RECORDING` are **documented
but inert** — no production code path reads them. See `src/services/calibrationCandidate.ts`.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start the server (Vite middleware, no HMR). |
| `npm run build` | Build the client bundle into `dist/`. |
| `npm start` | Start the server; serves `dist/` when `NODE_ENV=production`. |
| `npm test` | Run the Vitest suite. |
| `npm run lint` | `tsc --noEmit`. |
| `npm run predictions` | Read-only CLI printing today's model predictions. |

## API

| Route | Description |
|---|---|
| `GET /api/status` | Provider configuration and rate-limit state. Local only; does not call upstream. |
| `GET /api/competitions` | Supported competition catalogue. |
| `GET /api/fixtures` | Fixtures, with optional `dateFrom`, `dateTo`, `competition` filters. |
| `GET /api/matches/:id` | Single match detail. |
| `GET /api/standings` | League table. Optional `competition` (default `PL`). |
| `GET /api/odds/:id` | Odds for a match. Only meaningful when odds are enabled. |

Unknown `/api/*` routes return `404` as JSON.

## Deployment

Deployed on Render from `main` via the `Dockerfile` (`render.yaml` holds the blueprint).
The health check is `/api/status`, which is local-only and therefore does not consume provider
quota.

**Note:** auto-deploy is not currently wired to push events — the last deploy was triggered
through the Render API. Verify a deploy actually ran after merging, or trigger one manually.

## Model notes

The prediction engine is frozen at a canonical Poisson model. Two research findings are worth
keeping in mind when reading the numbers:

- The expected-goals clamp (`[0.3, 4.5]`) binds for a small share of fixtures and is part of the
  frozen contract; removing it does not improve held-out accuracy.
- Temperature calibration measurably improves ranking (RPS, CI excludes zero) but is **not
  wired**, because activating it changes every displayed probability. Fitting it properly
  requires strictly-prior settled results plus prospective shadow validation.

The intelligence panel states the model's known overconfidence directly: on held-out 2024/25,
fixtures rated above 80% occurred 73% of the time.
