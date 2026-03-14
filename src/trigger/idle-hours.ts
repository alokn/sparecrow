/** Pure idle hours schedule evaluation — determines whether current time falls within configured idle periods. */
import type { DayOfWeek, IdleHoursEntry } from '../types/index.js';
import { ScrowError, ErrorCode } from '../errors/index.js';

/** All valid day-of-week values for runtime validation of Intl output. */
const VALID_DAYS: ReadonlySet<string> = new Set<string>([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]);

/**
 * Parses an HH:MM time string into minutes since midnight (0-1439).
 * Validates input format defensively — throws ScrowError on malformed input.
 */
export function parseTimeToMinutes(time: string): number {
  if (typeof time !== 'string' || !time.includes(':')) {
    throw new ScrowError(
      ErrorCode.IDLE_HOURS_PARSE_ERROR,
      `Invalid time format "${String(time)}" — expected HH:MM`,
    );
  }
  const [hoursStr, minutesStr] = time.split(':');
  const hours = Number(hoursStr);
  const minutes = Number(minutesStr);
  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    throw new ScrowError(
      ErrorCode.IDLE_HOURS_PARSE_ERROR,
      `Invalid time value "${time}" — hours must be 00-23, minutes must be 00-59`,
    );
  }
  return hours * 60 + minutes;
}

/**
 * Checks whether a time (in minutes since midnight) falls within a range.
 * Handles overnight ranges where start > end (e.g. 22:00-06:00).
 *
 * For same-time ranges (start === end), treats as a full 24-hour window
 * (always returns true). This allows `start:"00:00", end:"00:00"` to
 * express "all day".
 */
export function isInTimeRange(
  nowMinutes: number,
  startMinutes: number,
  endMinutes: number,
): boolean {
  if (startMinutes === endMinutes) {
    // Same start/end = full 24-hour window
    return true;
  }

  if (startMinutes < endMinutes) {
    // Normal range: e.g. 00:00-06:00
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }

  // Overnight range: e.g. 22:00-06:00
  // True when nowMinutes >= startMinutes (before midnight) OR nowMinutes < endMinutes (after midnight)
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

/**
 * Gets the day-of-week name for a given date in a specific timezone.
 * Validates the Intl output is a known DayOfWeek value at runtime.
 */
function getDayOfWeek(now: Date, timezone: string): DayOfWeek {
  const formatter = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    timeZone: timezone,
  });
  const dayName = formatter.format(now).toLowerCase();
  if (!VALID_DAYS.has(dayName)) {
    throw new ScrowError(
      ErrorCode.IDLE_HOURS_PARSE_ERROR,
      `Intl.DateTimeFormat returned unexpected day name "${dayName}"`,
    );
  }
  return dayName as DayOfWeek;
}

/**
 * Gets the current time as minutes since midnight in the given timezone.
 * Throws ScrowError if Intl.DateTimeFormat fails to produce hour/minute parts.
 */
function getMinutesSinceMidnight(now: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    timeZone: timezone,
  });
  const parts = formatter.formatToParts(now);
  const hourPart = parts.find((p) => p.type === 'hour');
  const minutePart = parts.find((p) => p.type === 'minute');
  if (hourPart === undefined || minutePart === undefined) {
    throw new ScrowError(
      ErrorCode.IDLE_HOURS_PARSE_ERROR,
      `Intl.DateTimeFormat did not return hour/minute parts for timezone "${timezone}"`,
    );
  }
  const hour = Number(hourPart.value);
  const minute = Number(minutePart.value);
  return hour * 60 + minute;
}

/**
 * Evaluates whether the current time falls within any of the configured idle hours entries.
 * Returns true if ANY entry matches (logical OR).
 *
 * NOTE: Day-of-week filtering evaluates against the current calendar day in the
 * specified timezone. For overnight ranges with days (e.g. `{start:"22:00", end:"06:00",
 * days:["friday"]}`), the Saturday 02:00 portion will NOT match because the current
 * day is Saturday, not Friday. To cover that overnight window fully, add a second
 * entry: `{start:"00:00", end:"06:00", days:["saturday"]}`.
 *
 * @param entries - Array of idle hours entries from config. Empty array returns false.
 * @param now - The current date/time to evaluate against.
 * @param timezone - Optional IANA timezone string (e.g. 'America/New_York').
 *                   Defaults to the system's local timezone.
 */
export function isIdleTime(
  entries: ReadonlyArray<IdleHoursEntry>,
  now: Date,
  timezone?: string,
): boolean {
  if (entries.length === 0) {
    return false;
  }

  let tz: string;
  try {
    tz = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch (err: unknown) {
    throw new ScrowError(
      ErrorCode.IDLE_HOURS_INVALID_TIMEZONE,
      `Failed to resolve timezone: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err : undefined,
    );
  }

  let nowMinutes: number;
  let currentDay: DayOfWeek;
  try {
    nowMinutes = getMinutesSinceMidnight(now, tz);
    currentDay = getDayOfWeek(now, tz);
  } catch (err: unknown) {
    if (err instanceof ScrowError) {
      throw err;
    }
    // Wrap Intl RangeError (invalid timezone) in ScrowError
    throw new ScrowError(
      ErrorCode.IDLE_HOURS_INVALID_TIMEZONE,
      `Invalid timezone "${tz}": ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err : undefined,
    );
  }

  for (const entry of entries) {
    // Day-of-week filter: if days are specified, skip this entry if current day is not listed
    if (entry.days !== undefined && entry.days.length > 0) {
      if (!entry.days.includes(currentDay)) {
        continue;
      }
    }

    const startMinutes = parseTimeToMinutes(entry.start);
    const endMinutes = parseTimeToMinutes(entry.end);

    if (isInTimeRange(nowMinutes, startMinutes, endMinutes)) {
      return true;
    }
  }

  return false;
}
