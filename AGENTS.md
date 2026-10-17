# Project Touchline — Agent Notes

Football intelligence app: React (Vite) front end + Express proxy (`server.ts`) over
football-data.org and SportAPI.ai.

## Commands
- Typecheck: `npx tsc --noEmit`
- Tests: `npx vitest run` (Vitest + jsdom; 12 files / 141 tests)
- Build: `npm run build`
- Run server locally: `FOOTBALL_DATA_API_KEY=… SPORTAPI_KEY=… node --import tsx server.ts` (port 3000)

## Provider integration invariants
- football-data.org (free tier) requires an explicit `dateFrom`+`dateTo` window and
  rejects any span longer than 10 days with HTTP 400. Never send an open-ended query;
  use `resolveFixtureDateWindow()` in `src/services/fixtureAvailability.ts`.
- Never fetch football-data.org for a SportAPI-only competition — it burns the
  10 req/min quota. Guard with `SUPPORTED_COMPETITION_CODES`.
- Provider errors must surface as a degradation notice (`degraded`/`notice` on
  `/api/fixtures`), never a silent empty list. A sole-provider rate limit returns 429.
- `src/services/fixtureAvailability.ts` holds the pure, tested helpers
  (`summarizeFixtureFetch`, `resolveFixtureDateWindow`).

## Data-quality invariants (do not regress)
- Status hierarchy when merging fixtures: CANCELLED/POSTPONED/SUSPENDED > FINISHED >
  IN_PLAY/PAUSED > SCHEDULED/TIMED. A stale record must never regress a live/finished state.
- Score trust order in `mergeFixtureMetadata`: FINISHED final > fresher (non-delayed)
  provider > higher goal count. A delayed provider's score must never overwrite a fresher
  live score, and must never be labelled real-time (`isDelayed` follows the score's source).
- Dedup key = kickoff date (in competition grouping) + canonical competition + normalized
  home/away names. Direction (home/away) and competition must never be merged across.
- All kickoff rendering is timezone-aware; default zone is `Africa/Lagos` (WAT, UTC+1).

## Adding tests
- Cross-provider/lifecycle/staleness/timezone regressions live in
  `tests/live-match-data-reliability.test.ts`.
- Views that load fixtures call `FixtureService.getFixturesWithMeta()`; mocks must
  resolve `{ fixtures, degraded, notice }`, not a bare array.
- Prediction-engine validation (probability validity, temporal leakage, cold start,
  ledger immutability/dedup/settlement) lives in
  `tests/prediction-engine-validation.test.ts`.

## Prediction engine (FROZEN — do not change without a new model version)
- `src/services/predictionEngine.ts` is the canonical frozen Poisson model
  (`FROZEN_MODEL_VERSION = 'POISSON_V1_FROZEN'`). Attack/defence strengths, home
  advantage (1.14/0.88), xG clamps, the 3-match cold-start floor and 3dp rounding are
  all part of the frozen contract.
- The engine hard-enforces `playedGames >= 3` inside `evaluatePoissonProbabilities`,
  so it cannot be asked for a prediction below that threshold.
- Probabilities are finite and in [0,1] but can sum to 1.000 ± 0.001 because each leg
  is rounded independently. Use `PROBABILITY_SUM_TOLERANCE` (2e-3) in
  `src/services/predictionMetrics.ts` rather than an exact `=== 1` check.
- Evaluation reuses the frozen math (`calculateLeagueAverages`,
  `evaluatePoissonProbabilities`) rather than re-implementing it:
  - `src/services/predictionMetrics.ts` — log loss, Brier, calibration, aggregation.
  - `src/services/predictionBacktest.ts` — chronological, per-competition+season
    rolling tables (strictly-prior matches only; no future or cross-season leakage).
  - `src/services/predictionLedger.ts` — append-only, immutable prediction ledger.
- Manual, read-only utilities (not part of the app or the test suite):
  `scripts/fetch-historical.ts` (caches FD history under gitignored `.phase3-cache/`)
  and `scripts/run-evaluation.ts`.

## Research findings — what NOT to "fix" (backtested, do not re-litigate)
Measured on the local cache (`.phase3-cache/`, PL/PD/SA/CL 2023–2025, walk-forward,
strictly-prior tables). Held-out test = season years 2024 & 2025, paired block
bootstrap (seed 20261015, block 20, 2000 resamples). Reproduce with the scripts named.

- **The xG clamp `[0.3, 4.5]` is NOT a defect.** Removing it does not help. It binds for
  only 3.5% of predictions (121/3465), and on held-out data the clamp is marginally
  *better* (log loss meanDiff = -0.00104, CI [-0.00230, -0.00001], P(V1 better)=0.976);
  RPS and Brier show no reliable difference. The 4.50 in "xG: 4.50 - 0.76" is cosmetic.
  Re-run: `npx tsx scripts/run-xg-clamp-evaluation.ts`.
- **Dixon-Coles is not better than the frozen Poisson.** DC raw vs Frozen RPS
  meanDiff = -0.00015, CI [-0.00226, 0.00192] — no reliable difference, stable across
  block sizes 1–80. Swapping the model would add complexity for no measured gain.
- **The one real, measured improvement is temperature calibration.** DC+Cal vs Frozen RPS
  meanDiff = -0.00265, CI [-0.00510, -0.00015]; log loss -0.01415, CI
  [-0.02406, -0.00429]. But the calibration-only control (Frozen+Cal vs Frozen) captures
  essentially all of it: DC+Cal vs Frozen+Cal is a tie (CI includes 0). So the win is the
  calibration layer, not the model. The candidate already exists and is flag-gated
  (`ENABLE_PROBABILITY_CALIBRATION`, default OFF; `src/services/calibrationCandidate.ts`).
  Re-run: `npx tsx scripts/run-walkforward-evaluation.ts`.
- Consequence: the "structural ceiling" is model coverage and evidence, not a missing
  algorithm. Do not enable DC or remove the clamp without new held-out evidence.
- The `expectedGoalsBounds` option on `evaluatePoissonProbabilities` / `runBacktest` exists
  only for the ablation above. Production callers must omit it (defaults reproduce V1
  exactly; covered by a parity test).

## Odds layer (Phase 4 — comparison only, never feeds the model)
- Odds stay strictly separate from fixtures/results/standings and never change the frozen
  model. `/api/odds/:id` compares bookmaker 1X2 prices against the frozen probabilities.
- `src/services/oddsSchema.ts` — canonical `OddsObservation` + validation (finite positive
  decimals, freshness, fixture match, duplicate detection).
- `src/services/oddsAdapter.ts` — the real 5DollarFootballAPI contract
  (`https://api.5dollarfootballapi.com/v1`, `Authorization: Bearer` or `X-API-Key`).
  Failures are classified (`auth_error`, `plan_restricted`, `fixture_not_found`,
  `rate_limited`, `market_unavailable`, `network_error`) and never substituted with odds.
- `src/services/oddsValue.ts` — 1/odds implied probability, overround, proportional
  de-vig, probability difference (percentage points) and expected return
  (`modelProb × odds − 1`). Market prob, model prob, difference and EV are separate
  fields and are never merged into a "value" claim.
- `src/services/oddsEligibility.ts` — conservative gating (unavailable/stale/incomplete/
  mismatched → ineligible) and the honesty caveats (upper-tail overconfidence, CL weakness).
- The Odds API stays disabled (`ENABLE_ODDS_API=false`); no requests are made or credits
  spent. Never fill missing odds with mock or fabricated prices.
- Tests: `tests/odds-value-analysis.test.ts` (mock data is labelled test data).

## Daily Intelligence UX (transparency rules)
- The overview never shows another date's predictions unlabelled: when the selected date has no
  genuinely upcoming match, `DailyMatchIntelligence` renders an amber notice saying the ranked list
  is not for the selected date (`usingFallback`).
- Skip reasons are always summarised above the list ("Why N match(es) were skipped") using
  `classifyIntelligenceOutcome`. `evaluatedFixtures` (all evaluated, eligible and excluded) must be
  passed separately from `intelligenceList` (ranked/eligible only) — filtering the ranked list for
  ineligible matches always yields an empty set.
- Champions League is supported but structurally cannot be ranked until matchday 4: every CL team
  starts at `playedGames = 2`, below the frozen 3-match cold-start floor. This is intended, not a
  bug; the empty state says so explicitly.

## Phase 5 – operational readiness (verified behaviour)
- Competition capability is per-competition, never blanket. 78 competitions are registered;
  only PL/CL/PD/SA have football-data.org fixtures + working standings + prediction
  eligibility. All 78 have a SportAPI.ai league id (fixtures/live only when
  `SPORTAPI_KEY` is set). Verified odds coverage is 0.
- Half-time is a distinct state: `PAUSED` renders as "Half-Time" (never "In-Play") in
  `FixtureCard` and `MatchDetailView`. The fixtures status filter is labelled "Live".
- The competitions directory only offers the "Table" action for competitions whose
  registry entry has `standings: true`; `/api/standings` rejects the rest with HTTP 400.
- Timezone display is dynamic: the footer shows `getResolvedTimezone(timezoneId)` and the
  overview tile shows only the selected abbreviation (no hardcoded "UTC+1").
- Provider health is truthful: `/api/status` reports per-provider `status` and
  `capabilities`, including the 5DollarFootballAPI auth error and The Odds API disabled
  state. Secrets are never echoed in any response (only booleans / `missingConfig`).
- Regression tests: `tests/phase5-operational-readiness.test.tsx`.

## Phase 6B – controlled odds integration (verified behaviour)
- The Odds API is wired into the app but stays **gated**: `ENABLE_ODDS_API=true` (default
  false) *and* `ODDS_API_KEY` are both required before any request is sent. `false`/missing
  → `not_configured`, no network call.
- `/api/odds/:id?competition=<CODE>` resolves odds for one canonical fixture via
  `src/services/oddsService.ts` (`resolveOddsForFixture`). 5DollarFootballAPI is kept
  disabled as an odds source (invalid/revoked key); it is never called from the route.
- Provider modules: `oddsAdapter.ts` (`fetchTheOddsApiOdds`, `adaptTheOddsApiEvent`,
  `COMPETITION_TO_ODDS_SPORT_KEY`), `oddsFixtureMatch.ts` (`matchEventToFixture`),
  `oddsQuota.ts` (budget + `x-requests-remaining|used|last` tracking).
- Safety rules enforced (never guess): only verified sport-key mappings are used; events are
  matched by normalised club names **and** kickoff tolerance (default 15 min); zero matches →
  `no_candidate`, >1 → `ambiguous`, time outside tolerance → `kickoff_mismatch`; all yield
  `fixture_mismatch` and **no odds are attached**. Prices are never invented; genuine
  `last_update` timestamps are preserved and the canonical validator still rejects anything
  older than 24 h (`EXPIRED_OBSERVATION`) so stale prices are never shown as current.
- Budget: local monthly cap `ODDS_MONTHLY_REQUEST_BUDGET` (default 300, below the 500/month
  free tier) checked **before** sending, together with the provider-reported remaining
  credits. Exhaustion → `budget_exhausted`, no request sent. Counter resets each UTC month.
- The Odds API request shape: `GET /v4/sports/{sport}/odds?markets=h2h&regions=uk&
  oddsFormat=decimal&dateFormat=iso` (cost = markets × regions = 1). Draw is the `Draw`
  outcome; home/away matched by the event's own team names.
- Verified live (Phase 6B): real football-data.org fixture `fd-560603 Everton FC vs Chelsea
  FC` matched the Odds API event and produced 21 validated bookmaker 1X2 observations for 1
  credit. Odds coverage is no longer 0 when the integration is enabled.
- Regression tests: `tests/phase6b-odds-api-integration.test.ts` (29 tests, injected fetch,
  no network).

## Deployment — Render (live)
- Live URL: https://touchline-football.onrender.com (service `Touchline-football-`,
  id `srv-db936o8n74is73dbhe6g`, free plan, region `oregon`, auto-deploy on push to `main`).
- Runtime is **Docker** (`./Dockerfile`): `npm install --include=dev` then `npm run build`,
  start `npm start` (= `tsx server.ts`). `render.yaml` mirrors this.
- `server.ts` reads `PORT` from the env (falls back to 3000); `tsx` is a **dependency**, not
  a devDependency, because `NODE_ENV=production` installs omit devDependencies.
- `package-lock.json` is committed and `npm ci` is the install path. Do not add
  `--legacy-peer-deps` to silence conflicts — bump the offending package instead.
- Known trap: `esbuild` must satisfy vite 8's peer range (`^0.27 || ^0.28`). A stale
  `esbuild@^0.25.0` broke the Docker build with ERESOLVE. esbuild is not imported directly.
- Secrets live in the Render dashboard (`FOOTBALL_DATA_API_KEY` only). Never commit `.env`.
- Render API access is via a `RENDER_API_KEY` bearer token; deploy status:
  `GET /v1/services/{id}/deploys`, logs: `GET /v1/logs?ownerId=…&resource=…`.
- Free tier sleeps after ~15 min idle; first hit cold-starts in ~30–60 s.

