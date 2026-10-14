import { describe, it, expect } from 'vitest';
import {
  formatKickoffTime,
  formatMatchDate,
  formatKickoffFull,
  getDateKeyInTimezone,
  DEFAULT_TIMEZONE,
  getTimezoneAbbr
} from '../src/utils/timezone';

describe('Timezone Handling & Kickoff Formatting', () => {
  const sampleIso = '2026-10-11T13:00:00Z'; // 13:00 UTC -> 14:00 Africa/Lagos (WAT, UTC+1)

  it('formats valid ISO timestamps in Africa/Lagos (WAT) by default', () => {
    const formatted = formatKickoffTime(sampleIso, DEFAULT_TIMEZONE);
    expect(formatted).toBe('14:00 WAT');
  });

  it('formats valid ISO timestamps in UTC when requested', () => {
    const formattedUtc = formatKickoffTime(sampleIso, 'UTC');
    expect(formattedUtc).toBe('13:00 UTC');
  });

  it('formats full match datetimes with day, month, year and time', () => {
    const fullWat = formatKickoffFull(sampleIso, 'Africa/Lagos');
    expect(fullWat).toContain('11 October 2026');
    expect(fullWat).toContain('14:00 WAT');
  });

  it('does NOT mutate the input timestamp string', () => {
    const original = '2026-10-11T15:30:00Z';
    const snapshot = original.slice();
    const formatted1 = formatKickoffTime(original, 'Africa/Lagos');
    const formatted2 = formatKickoffTime(original, 'UTC');
    expect(original).toBe(snapshot);
    expect(formatted1).toBe('16:30 WAT');
    expect(formatted2).toBe('15:30 UTC');
  });

  it('returns safe fallback without throwing on missing or null timestamps', () => {
    expect(formatKickoffTime(null)).toBe('TBD');
    expect(formatKickoffTime(undefined)).toBe('TBD');
    expect(formatKickoffTime('')).toBe('TBD');
    expect(formatKickoffTime('invalid-date-string')).toBe('TBD');

    expect(formatMatchDate(null)).toBe('Date unavailable');
    expect(formatMatchDate(undefined)).toBe('Date unavailable');
    expect(formatMatchDate('')).toBe('Date unavailable');
    expect(formatMatchDate('invalid-date')).toBe('Date unavailable');

    expect(formatKickoffFull(null)).toBe('Kickoff time unavailable');
    expect(formatKickoffFull(undefined)).toBe('Kickoff time unavailable');
    expect(formatKickoffFull('')).toBe('Kickoff time unavailable');
  });

  it('ensures missing timestamps NEVER evaluate to the 1970 Unix epoch', () => {
    // In JavaScript, new Date(null) evaluates to 1970-01-01. Our hardened code must prevent this!
    const nullFull = formatKickoffFull(null);
    expect(nullFull).not.toContain('1970');
    expect(nullFull).toBe('Kickoff time unavailable');

    const emptyFull = formatKickoffFull('');
    expect(emptyFull).not.toContain('1970');

    const nullDateKey = getDateKeyInTimezone(null);
    expect(nullDateKey).not.toContain('1970');
    expect(nullDateKey).toBe('');
  });

  it('derives timezone-specific date keys correctly across day boundaries', () => {
    // 23:30 UTC on 11 Oct is 00:30 WAT on 12 Oct (next day in Lagos)
    const lateNightUtc = '2026-10-11T23:30:00Z';
    const lagosDateKey = getDateKeyInTimezone(lateNightUtc, 'Africa/Lagos');
    const utcDateKey = getDateKeyInTimezone(lateNightUtc, 'UTC');

    expect(lagosDateKey).toBe('2026-10-12');
    expect(utcDateKey).toBe('2026-10-11');
  });

  it('provides correct timezone abbreviations', () => {
    expect(getTimezoneAbbr('Africa/Lagos')).toBe('WAT');
    expect(getTimezoneAbbr('UTC')).toBe('UTC');
    expect(getTimezoneAbbr('Europe/London')).toBe('UK');
  });
});
