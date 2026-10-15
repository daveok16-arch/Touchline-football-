/**
 * Project Touchline – Fixture Freshness
 *
 * Live fixtures carry a provider `lastUpdated` timestamp. When that timestamp is
 * older than the expected provider refresh window, the displayed score may be
 * behind the live state and is surfaced as stale rather than silently trusted.
 */

import { Fixture } from '../types/football';

/** Live providers refresh within a minute; allow a generous multiple before flagging stale. */
export const LIVE_STALE_THRESHOLD_MS = 5 * 60 * 1000;

function isLiveStatus(status: Fixture['status']): boolean {
  return status === 'IN_PLAY' || status === 'PAUSED';
}

/**
 * Returns true when a live fixture's provider update is older than the staleness
 * threshold. Non-live fixtures are never flagged (their score is not expected to change).
 * A live fixture with no timestamp is not flagged, since freshness cannot be asserted.
 */
export function isFixtureStale(fixture?: Fixture | null, asOfMs: number = Date.now()): boolean {
  if (!fixture || !isLiveStatus(fixture.status)) return false;
  if (!fixture.lastUpdated) return false;
  const updatedMs = new Date(fixture.lastUpdated).getTime();
  if (isNaN(updatedMs)) return false;
  return asOfMs - updatedMs > LIVE_STALE_THRESHOLD_MS;
}
