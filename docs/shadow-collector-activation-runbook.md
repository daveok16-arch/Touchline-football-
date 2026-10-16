# Shadow Collector — Activation Runbook (preparation only)

Status: **NOT ACTIVATED.** Every feature flag is `false`. This document describes how a future,
explicitly approved controlled activation would be performed. It is not a request to activate.

The shadow collector is research-only: it records prospective forecasts and results into a shadow
ledger. It does not affect the prediction engine, the betting protocol, the UI, or historical data.

## 1. Scope and non-goals

In scope on activation:

- A single, manually-driven collector loop over same-origin Touchline endpoints.
- Durable request accounting (per-minute window + per-day ceiling).
- Prospective forecast capture and result settlement into the shadow ledger.

Out of scope (must stay off until separately approved):

- No automatic scheduler. The loop is driven by an operator (or an already-approved external
  trigger), never `setInterval`/cron inside the app.
- No wiring into production startup (`server.ts` / app bootstrap).
- No change to `predictionEngine.ts`, the betting protocol, or historical data.
- No use of provider credentials beyond the existing server-side token helpers.

## 2. Prerequisites

1. All four flags verified `false` in the environment:
   `ENABLE_ODDS_API`, `ENABLE_PROBABILITY_CALIBRATION`, `ENABLE_SHADOW_CALIBRATION_RECORDING`,
   `ENABLE_SHADOW_COLLECTOR`.
2. The frozen engine hash is unchanged:
   `0927cd456c451e688d686b020ae258a405f75f5e37e1e139f2dff1ef3785ba6c`
   (`sha256sum src/services/predictionEngine.ts`).
3. Full offline verification green: `npx vitest run`, `npx tsc --noEmit`, `npm run build`.
4. A server-side fixtures-provider credential is configured for the same-origin API
   (`FOOTBALL_DATA_API_KEY` / `FOOTBALL_DATA_TOKEN` / `FOOTBALL_DATA_ORG_TOKEN`, or `SPORTAPI_KEY`).
   The adapter itself holds no credentials and calls only the local API.
5. Writable, gitignored state locations exist (created automatically on first write):
   - bundle: `.phaseS-collector/collector-bundle.json` (+ `.bak`)
   - write-ahead budget sink: `.phaseS-collector/collector-budget.json`
6. The collectors are constructed explicitly by the operator entry point with both sinks wired:
   `budgetSink: new FileBudgetSink(...)`, `bundleSink` over `CollectorBundleStore.save`.

## 3. Hard limits (enforced in code, not just documented)

| Limit | Default | Where enforced |
|---|---|---|
| Per-day ceiling | **500 requests/day** (`DEFAULT_BUDGET.perDay`) | `RequestBudget` (durable, clamped on restore) |
| Per-minute window | **10 requests/minute** (`DEFAULT_BUDGET.perMinute`) | `RequestBudget` sliding window (durable across restart) |
| Per-tick cap | 10 requests (`maxRequestsPerTick`) | `charge()` |
| Discovery interval | 6h (`discoveryIntervalMs`) | `runOnce` |
| Result poll interval | 20m (`resultPollIntervalMs`) | `runOnce` |
| Discovery horizon | 7 days (`discoveryHorizonMs`) | `mergeDiscovered` |
| Correction window | 24h @ every 3h | `runOnce` |
| Forward-clock halt | gap > **48h** (`maxForwardJumpMs`) | `runOnce` (halts the tick) |
| Backward-clock halt | gap > 5m (`clockJumpToleranceMs`) | `runOnce` (halts the tick) |

Budget accounting is durable: the daily counter and minute window are written to the write-ahead
sink before each request and committed with the bundle at tick end. A restart cannot reset either
limit.

## 4. Fail-closed persistence contract

A request is issued only when its charge can be durably recorded:

- Sink write fails -> request refused, `persistenceFailed` latch set, no request issued.
- No sink + bundle commit fails -> `persistenceFailed` latch set, no further requests issued.
- While latched, `runOnce` returns `skipped='PERSISTENCE_FAILED'`, issues no requests, and does not
  advance research state. The latch is persisted, so it survives restarts.

Clear the latch only after persistence is restored, by constructing the collector with
`resetPersistenceFailure: true` for one tick.

## 5. Minimal first-run collection window

Goal: prove the loop end-to-end with the smallest possible footprint.

- **Window:** one competition (e.g. `PL`), a single kickoff slate within the next 7 days.
- **Duration:** the shortest span that covers discovery -> capture (kickoff-26h..kickoff-22h) ->
  settlement (kickoff + ~2h) for that slate. Typically one slate in a single UTC day.
- **Request budget:** keep `perDay` at 500 but expect well under it. A 15-fixture slate with no
  corrections is ~23 requests/day (see `scripts/dry-run-shadow-collector.ts`).
- **Driver:** manual, one `runOnce` per tick, operator-paced. No scheduler.
- **Enablement:** only `ENABLE_SHADOW_COLLECTOR` may be flipped, and only for the window; the other
  three flags stay `false`.

Stop conditions (halt immediately and revert the flag):

- Any `PERSISTENCE_FAILED` / `persistenceFailed` latch.
- Any `CLOCK_FORWARD_JUMP` or `CLOCK_JUMP` diagnostic.
- `requestsDenied` with reason `PER_DAY` before the slate is fully settled.
- Any `PROVIDER_CONFLICT` / `QUARANTINED` note (investigate before continuing).
- Any unexpected `SERVER_ERROR`/`NETWORK` burst, or provider 429 (rate limit).
- Any divergence between the dry-run expectation and observed request counts.

## 6. Monitoring

Watch the tick diagnostic returned by `runOnce`:

- `requestsAttempted` / `requestsDenied` / `requestsCapped` / `requestsUnpersisted`
- `budget` (`usedToday`, `usedThisMinute`) vs the 500 / 10 limits
- `skipped` (`DISABLED` | `CLOCK_JUMP` | `CLOCK_FORWARD_JUMP` | `PERSISTENCE_FAILED`)
- `persistenceFailed`
- `notes[]`: `BUDGET_DENIED:*`, `PERSISTENCE_FAILED:*`, `CLOCK_*`, `PROVIDER_CONFLICT:*`,
  `QUARANTINED:*`, `QUARANTINE_SKIP:*`, `RESCHEDULED:*`, `SETTLE_REJECTED:*`
- `captures` / `settlements` / `corrections` / `verifications`
- Bundle `commit` counter and the journal line in `.phaseS-collector/` (advancing = healthy).

## 7. Emergency shutdown

1. Set `ENABLE_SHADOW_COLLECTOR=false`. `runOnce` then returns `skipped='DISABLED'` with no I/O.
2. Stop the manual driver loop.
3. Leave the bundle/sink files in place (they are the durable record; do not delete).

## 8. Rollback

1. Set `ENABLE_SHADOW_COLLECTOR=false` (and confirm the other three remain `false`).
2. Remove the collector entry point from whatever manually invoked it; the app never imports it, so
   no app rollback is needed.
3. Optionally archive `.phaseS-collector/` for the record; it is gitignored and never committed.
4. Confirm the engine hash is unchanged and the full suite / tsc / build are green.

## 9. Quarantine recovery

A fixture id that appears with conflicting provider identity (same id, different team ids) is
permanently quarantined and never recorded again. To recover an id after the provider data is
corrected, remove it from `state.quarantined` in the bundle and re-save. This is a manual,
deliberate action; there is no automatic release.

## 10. Explicit "do not" list for the activation step

- Do not enable a scheduler or wire the collector into `server.ts`/app startup.
- Do not flip `ENABLE_ODDS_API`, `ENABLE_PROBABILITY_CALIBRATION`, or
  `ENABLE_SHADOW_CALIBRATION_RECORDING`.
- Do not modify the frozen prediction engine, betting protocol, or historical data.
- Do not run a live smoke test until this runbook is approved and the offline verification is green.

---

# Multi-Day Shadow Validation – Operator Runbook

Status: **PREPARATION.** The collector is NOT activated. All four flags are `false`. This section
prepares a controlled, operator-paced, multi-day observation. It is not a request to activate.

## Preconditions (offline, before any live tick)

- `npx tsc --noEmit` → exit 0.
- `npx vitest run` → all green (T3 fail-closed, audit, transport, purity, shadow-validation).
- `npm run build` → OK.
- `sha256sum src/services/predictionEngine.ts` =
  `0927cd456c451e688d686b020ae258a405f75f5e37e1e139f2dff1ef3785ba6c`.
- All four flags verified `false`.

## 0. Debug-only read-only status helper (optional, local, NOT committed)

Because the collector is **not** wired into startup, a sample of the state is read directly from the
bundle file. This helper only reads; it starts no server and makes no provider calls. Any equivalent
script works; it is a convenience, not part of the repo.

```bash
# write the helper shown below to /tmp/touchline-shadow-status.mjs, then:
node /tmp/touchline-shadow-status.mjs
```

Helper contents (Node ESM; reads the bundle + budget file only):

```js
import fs from 'fs';
const BUNDLE = process.env.TOUCHLINE_BUNDLE || '.phaseS-collector/collector-bundle.json';
const BUDGET = process.env.TOUCHLINE_BUDGET || '.phaseS-collector/collector-budget.json';
const b = fs.existsSync(BUNDLE) ? JSON.parse(fs.readFileSync(BUNDLE, 'utf8')) : null;
const s = fs.existsSync(BUDGET) ? JSON.parse(fs.readFileSync(BUDGET, 'utf8')) : null;
console.log('bundle commit =', b?.commit ?? '(none)');
console.log('persistenceFailed =', b?.state?.persistenceFailed ?? false);
console.log('quarantined =', b?.state?.quarantined ?? []);
console.log('budget file =', s ?? '(none)');
const pend = b?.state?.pending ?? [];
console.log('pending =', pend.length, '| captured =', pend.filter(p=>p.captured).length,
  '| settled =', pend.filter(p=>p.settled).length, '| superseded =', pend.filter(p=>p.superseded).length);
console.log('forecasts =', b?.snapshot?.forecasts?.length ?? 0,
  '| primary =', (b?.snapshot?.forecasts ?? []).filter(f=>f.isPrimary).length);
console.log('results =', b?.snapshot?.results?.length ?? 0);
const now = Date.now();
for (const p of pend.filter(p=>!p.superseded && !p.captured && new Date(p.kickoffTime).getTime() > now)) {
  const k = new Date(p.kickoffTime).getTime();
  const win = { open: k-26*3600e3, target: k-24*3600e3, close: k-22*3600e3 };
  const state = now < win.open ? `not-yet (opens in ${((win.open-now)/3600e3).toFixed(1)}h)`
    : now <= win.close ? 'IN WINDOW (eligible now)' : 'window closed';
  console.log(`  ${p.fixtureId} ${p.competitionCode} kickoff=${p.kickoffTime} :: ${state}`);
}
```

## 1. Confirm a fixture is approaching the eligible capture window

Using the helper above, a fixture is capture-eligible only when `now ∈ [kickoff−26h, kickoff−22h]`
(target `kickoff−24h`, ±2h preregistered). Do **not** assume eligibility: require the printed
fixture row to say `IN WINDOW (eligible now)` and the kickoff time to be in the future.

Exact read-only eligibility command (reads the bundle only; starts nothing, makes no request):

```bash
node --input-type=module -e '
import fs from "fs";
const B = process.env.TOUCHLINE_BUNDLE || ".phaseS-collector/collector-bundle.json";
const D = process.env.TOUCHLINE_BUDGET || ".phaseS-collector/collector-budget.json";
const now = Date.now();
const bundleOk = fs.existsSync(B), sinkOk = fs.existsSync(D);
console.log("durable stores:", { bundle: bundleOk, budgetSink: sinkOk });
if (!bundleOk) { console.log("NO BUNDLE - run one bounded operator tick first."); process.exit(0); }
const b = JSON.parse(fs.readFileSync(B,"utf8"));
let n = 0;
for (const p of (b.state?.pending ?? []).filter(p => !p.superseded && !p.captured)) {
  const k = new Date(p.kickoffTime).getTime();
  if (now >= k-26*3600e3 && now <= k-22*3600e3 && k > now) { n++; console.log("ELIGIBLE", p.fixtureId, p.competitionCode, "kickoff", p.kickoffTime); }
}
console.log(n ? n+" fixture(s) IN WINDOW." : "No fixture inside [kickoff-26h, kickoff-22h] yet.");
'
```


## 2. Start the local server only when needed

```bash
FOOTBALL_DATA_API_KEY="$FOOTBALL_DATA_API_KEY" SPORTAPI_KEY="$SPORTAPI_KEY" node --import tsx server.ts &
curl -s http://localhost:3000/api/status | head -c 200   # provider configured, tier, rateLimitPerMinute
```

Stop it between observation windows to avoid idle provider traffic:
`kill <PID>` (find it with `ps aux | grep 'node --import tsx server.ts'`).

## 3. Run one bounded collector tick

One tick, operator-paced, both durable sinks wired, one request per discovery window. Run the
uncommitted driver from `/tmp` (see the smoke-test driver pattern); do not add it to the repo and
do not schedule it. A single tick issues at most `maxRequestsPerTick` (10) requests.

### Operator driver (fail-closed preflight + first-observation cap)

Use `createOperatorDriver` from `src/services/shadowOperatorDriver.ts` for the first prospective
observation. It is a thin, un-wired wrapper that:

- **Refuses to run before any provider request** unless both the `BudgetSink` and the
  `CollectorBundleStore` are present, initialized, and durably writable (value-preserving write
  probes; no silent fallback to non-durable mode). It throws `DurableStoreUnavailableError`.
- Pins an explicit per-tick request cap of **≤ 3** (`OPERATOR_MAX_REQUESTS_PER_TICK`). The cap is
  layered on top of the shared `RequestBudget`, so it can never widen the per-minute/per-day
  ceiling — a budget denial always wins.
- **Shares one `RequestBudget` instance** between the forecast provider's standings source and the
  collector, so standings fetches and collector requests are charged to the SAME durable counter.
  Without this, standings charges land in a private in-memory counter and the persisted counter
  would under-report usage.
- Completes exactly one durable bundle commit per executed tick (including a capture that charged
  no request because standings were already primed), so a new forecast is never dropped.

```js
const budget = new RequestBudget(DEFAULT_BUDGET);            // ONE shared instance
const provider = new StandingsForecastProvider({ standings, budget, snapshot: () => store.load().bundle.snapshot });
await provider.primeStandings(['PL', 'PD', 'SA', 'CL'], Date.now());  // charges the shared budget
const driver = createOperatorDriver({
  transport: adapters.transport,
  forecasts: provider,
  bundleStore,                   // CollectorBundleStore
  budgetSink,                    // FileBudgetSink
  budgetInstance: budget,        // same instance -> one shared durable ceiling
});
driver.requireVerified();        // throws before any request if storage is unverified
const out = await driver.runOnce(/* enabled */ true);
```

Do not call this from startup or a scheduler. Construct it in the operator script each run.


## 4. Confirm predictions, timestamps, budget, persistence

From the tick diagnostic and the helper:

- `requestsAttempted` ≤ 3 for the first observation (operator cap) and ≥ 0; `requestsDenied`/`requestsCapped` explained by notes.
- `budget.usedToday` ≤ 500 and `budget.usedThisMinute` ≤ 10.
- `persistenceFailed` is `false`; `skipped` is unset.
- Each new capture: `mode='prospective'`, `generatedAt` before kickoff and ≤ now, exactly one
  `isPrimary` per fixture/version, `eligibility.eligible` true only inside the window.
- `notes[]` free of `PROVIDER_CONFLICT`, `QUARANTINED`, `CLOCK_*`, `PERSISTENCE_FAILED`.
- Bundle `commit` incremented and a journal line appended (`.phaseS-collector/*.journal`).

## 5. Restart and verify recovery

Stop the process, re-run the helper and one tick on the same bundle:

- `commit` continues from the persisted value; no duplicate forecasts (forecast count unchanged).
- `budget.usedToday` recovers from the bundle/sink and does **not** reset to 0 within the UTC day.
- `persistenceFailed` and `quarantined[]` unchanged.
- No additional request is issued before the discovery/poll interval elapses.

## 6. Check results and corrections after kickoff

After a captured fixture's kickoff: one poll per `resultPollIntervalMs` (20m) until `FINISHED` with
scores; settlement appends a result with `outcomeKnownAtMs ≥ kickoffMs`. A later score change appends
a **correction** revision (never rewrites history); the fixture is `final` after the 24h window.

## 7. Stop immediately if any of these hold

- `persistenceFailed` is `true`, or `skipped='PERSISTENCE_FAILED'`.
- `skipped='CLOCK_JUMP'` or `'CLOCK_FORWARD_JUMP'`.
- `requestsDenied` reason `PER_DAY`/`PER_MINUTE` before the slate settles.
- Any `PROVIDER_CONFLICT`/`QUARANTINED` note, or a 429/5xx burst.
- A capture recorded for a superseded version, or any forecast with `generatedAt ≥ kickoff`.
- More than one primary forecast for a fixture, or a replay-mode record in the prospective snapshot.
- Any health-check failure (`/api/status` shows the provider unconfigured or degraded unexpectedly).

On a stop condition: set `ENABLE_SHADOW_COLLECTOR=false`, stop the driver, leave the bundle in place.

## 8. Completion criteria

The observation is complete only after **real prospective** fixtures have passed through:

1. Eligible capture (`eligibility.eligible=true`) and a persisted primary forecast.
2. Kickoff and subsequent result polling.
3. Final settlement, plus any correction appended as a new revision.
4. A restart showing no duplicate primary forecasts and no lost budget usage.

Keep historical replay results separate from live prospective evidence. A prospective fixture only
counts as evidence if its primary forecast was created from live data inside the window; replay-mode
records never satisfy these criteria. Suggested minimum: complete one full capture→kickoff→settle→
restart cycle for at least 3 distinct prospective fixtures, with zero stop conditions triggered.

## 9. Remaining risks

- Activation wiring still absent by design: the operator must construct the collector each run and
  wire both sinks; a missing sink silently drops to legacy non-durable mode (documented in §4).
- The per-day ceiling (500) exceeds the free-tier 10/min if the provider is only the free tier;
  the minute window is the binding constraint and must be watched.
- Long tail: a fixture may never settle (postponed/cancelled) and stays pending without a result;
  that is expected and is not a failure.

