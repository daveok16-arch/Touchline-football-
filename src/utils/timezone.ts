export interface TimezoneOption {
  id: string;
  label: string;
  abbr: string;
  city: string;
}

export const SUPPORTED_TIMEZONES: TimezoneOption[] = [
  {
    id: 'Africa/Lagos',
    label: 'West Africa Time (WAT – UTC+1)',
    abbr: 'WAT',
    city: 'Lagos',
  },
  {
    id: 'UTC',
    label: 'Coordinated Universal Time (UTC)',
    abbr: 'UTC',
    city: 'UTC',
  },
  {
    id: 'Europe/London',
    label: 'United Kingdom (GMT / BST)',
    abbr: 'UK',
    city: 'London',
  },
  {
    id: 'Europe/Madrid',
    label: 'Central European Time (CET / CEST)',
    abbr: 'CET',
    city: 'Madrid / Paris',
  },
  {
    id: 'America/New_York',
    label: 'Eastern Time (ET)',
    abbr: 'ET',
    city: 'New York',
  },
  {
    id: 'local',
    label: 'Browser Local Time',
    abbr: 'LOCAL',
    city: 'Device Time',
  },
];

export const DEFAULT_TIMEZONE = 'Africa/Lagos';

/**
 * Returns the effective IANA timezone string.
 * If user selected 'local', attempts to resolve browser's timezone or falls back to Africa/Lagos.
 */
export function getResolvedTimezone(tzId: string): string {
  if (tzId === 'local') {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIMEZONE;
    } catch {
      return DEFAULT_TIMEZONE;
    }
  }
  return tzId;
}

/**
 * Returns abbreviation for the current timezone
 */
export function getTimezoneAbbr(tzId: string): string {
  const found = SUPPORTED_TIMEZONES.find((t) => t.id === tzId);
  return found ? found.abbr : 'WAT';
}

/**
 * Formats match kickoff time (e.g. "17:30 WAT" or "20:00 UTC")
 */
export function formatKickoffTime(utcIsoString?: string | null, tzId: string = DEFAULT_TIMEZONE): string {
  if (!utcIsoString || typeof utcIsoString !== 'string') return 'TBD';
  try {
    const date = new Date(utcIsoString);
    if (isNaN(date.getTime())) return 'TBD';
    const timeZone = getResolvedTimezone(tzId);
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const timeStr = formatter.format(date);
    const abbr = getTimezoneAbbr(tzId);
    return `${timeStr} ${abbr}`;
  } catch {
    return 'TBD';
  }
}

/**
 * Formats match date concisely (e.g. "Sun, 11 Oct")
 */
export function formatMatchDate(utcIsoString?: string | null, tzId: string = DEFAULT_TIMEZONE): string {
  if (!utcIsoString || typeof utcIsoString !== 'string') return 'Date unavailable';
  try {
    const date = new Date(utcIsoString);
    if (isNaN(date.getTime())) return 'Date unavailable';
    const timeZone = getResolvedTimezone(tzId);
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
    return formatter.format(date);
  } catch {
    return 'Date unavailable';
  }
}

/**
 * Formats full match date & time (e.g. "Sunday, 11 October 2026 – 17:30 WAT")
 */
export function formatKickoffFull(utcIsoString?: string | null, tzId: string = DEFAULT_TIMEZONE): string {
  if (!utcIsoString || typeof utcIsoString !== 'string') return 'Kickoff time unavailable';
  try {
    const date = new Date(utcIsoString);
    if (isNaN(date.getTime())) return 'Kickoff time unavailable';
    const timeZone = getResolvedTimezone(tzId);
    const dateFormatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    const timeFormatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const dateStr = dateFormatter.format(date);
    const timeStr = timeFormatter.format(date);
    const abbr = getTimezoneAbbr(tzId);
    return `${dateStr} – ${timeStr} ${abbr}`;
  } catch {
    return 'Kickoff time unavailable';
  }
}

/**
 * Returns date in YYYY-MM-DD format for a given ISO string in the target timezone.
 * Used for reliable day-level grouping and filtering in the user's selected timezone.
 */
export function getDateKeyInTimezone(utcIsoString?: string | null, tzId: string = DEFAULT_TIMEZONE): string {
  if (!utcIsoString || typeof utcIsoString !== 'string') return '';
  try {
    const date = new Date(utcIsoString);
    if (isNaN(date.getTime())) return '';
    const timeZone = getResolvedTimezone(tzId);
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    // en-CA produces YYYY-MM-DD
    return formatter.format(date);
  } catch {
    return '';
  }
}
