/** Unit tests for idle hours schedule evaluation — time range matching, midnight crossing, day-of-week filtering. */
import { describe, it, expect } from 'vitest';
import type { IdleHoursEntry } from '../types/index.js';
import { isIdleTime, parseTimeToMinutes, isInTimeRange } from './idle-hours.js';

/**
 * Helper to create a Date at a specific day/time in UTC.
 * month is 0-based (0=Jan). dayOfMonth is 1-based.
 */
function utcDate(
  year: number,
  month: number,
  dayOfMonth: number,
  hours: number,
  minutes: number,
): Date {
  return new Date(Date.UTC(year, month, dayOfMonth, hours, minutes, 0, 0));
}

// 2026-03-02 is a Monday in UTC
// 2026-03-07 is a Saturday in UTC
// 2026-03-08 is a Sunday in UTC
// 2026-03-03 is a Tuesday in UTC

describe('parseTimeToMinutes', () => {
  it('parses 00:00 to 0', () => {
    expect(parseTimeToMinutes('00:00')).toBe(0);
  });

  it('parses 06:00 to 360', () => {
    expect(parseTimeToMinutes('06:00')).toBe(360);
  });

  it('parses 23:59 to 1439', () => {
    expect(parseTimeToMinutes('23:59')).toBe(1439);
  });

  it('parses 12:30 to 750', () => {
    expect(parseTimeToMinutes('12:30')).toBe(750);
  });

  it('parses 22:00 to 1320', () => {
    expect(parseTimeToMinutes('22:00')).toBe(1320);
  });

  it('throws ScrowError for malformed input without colon', () => {
    expect(() => parseTimeToMinutes('1200')).toThrow(
      expect.objectContaining({ code: 'IDLE_HOURS_PARSE_ERROR' }),
    );
  });

  it('throws ScrowError for empty string', () => {
    expect(() => parseTimeToMinutes('')).toThrow(
      expect.objectContaining({ code: 'IDLE_HOURS_PARSE_ERROR' }),
    );
  });

  it('throws ScrowError for out-of-range hours', () => {
    expect(() => parseTimeToMinutes('25:00')).toThrow(
      expect.objectContaining({ code: 'IDLE_HOURS_PARSE_ERROR' }),
    );
  });

  it('throws ScrowError for out-of-range minutes', () => {
    expect(() => parseTimeToMinutes('12:60')).toThrow(
      expect.objectContaining({ code: 'IDLE_HOURS_PARSE_ERROR' }),
    );
  });

  it('throws ScrowError for non-numeric parts', () => {
    expect(() => parseTimeToMinutes('ab:cd')).toThrow(
      expect.objectContaining({ code: 'IDLE_HOURS_PARSE_ERROR' }),
    );
  });
});

describe('isInTimeRange', () => {
  it('returns true for time within normal range', () => {
    // 00:00-06:00, check 03:00 (180 minutes)
    expect(isInTimeRange(180, 0, 360)).toBe(true);
  });

  it('returns false for time outside normal range', () => {
    // 00:00-06:00, check 12:00 (720 minutes)
    expect(isInTimeRange(720, 0, 360)).toBe(false);
  });

  it('returns true at exact start of range', () => {
    // 06:00-12:00, check 06:00 (360 minutes)
    expect(isInTimeRange(360, 360, 720)).toBe(true);
  });

  it('returns false at exact end of range', () => {
    // 06:00-12:00, check 12:00 (720 minutes)
    expect(isInTimeRange(720, 360, 720)).toBe(false);
  });

  it('returns true for overnight range before midnight', () => {
    // 22:00-06:00, check 23:30 (1410 minutes)
    expect(isInTimeRange(1410, 1320, 360)).toBe(true);
  });

  it('returns true for overnight range after midnight', () => {
    // 22:00-06:00, check 02:00 (120 minutes)
    expect(isInTimeRange(120, 1320, 360)).toBe(true);
  });

  it('returns false for overnight range during day', () => {
    // 22:00-06:00, check 12:00 (720 minutes)
    expect(isInTimeRange(720, 1320, 360)).toBe(false);
  });

  it('returns true for same-time range (full 24-hour window)', () => {
    // start === end means full day coverage
    expect(isInTimeRange(360, 360, 360)).toBe(true);
    expect(isInTimeRange(0, 0, 0)).toBe(true);
    expect(isInTimeRange(720, 0, 0)).toBe(true);
  });

  it('returns true at exact start of overnight range', () => {
    // 22:00-06:00, check 22:00 (1320 minutes)
    expect(isInTimeRange(1320, 1320, 360)).toBe(true);
  });

  it('returns false at exact end of overnight range', () => {
    // 22:00-06:00, check 06:00 (360 minutes)
    expect(isInTimeRange(360, 1320, 360)).toBe(false);
  });
});

describe('isIdleTime', () => {
  // AC1: Simple idle_hours config
  describe('simple time range (AC1)', () => {
    const entries: IdleHoursEntry[] = [{ start: '00:00', end: '06:00' }];

    it('returns true at 03:00 UTC within range', () => {
      const now = utcDate(2026, 2, 2, 3, 0); // Monday 03:00 UTC
      expect(isIdleTime(entries, now, 'UTC')).toBe(true);
    });

    it('returns false at 12:00 UTC outside range', () => {
      const now = utcDate(2026, 2, 2, 12, 0); // Monday 12:00 UTC
      expect(isIdleTime(entries, now, 'UTC')).toBe(false);
    });

    it('returns true at 00:00 UTC (exact start)', () => {
      const now = utcDate(2026, 2, 2, 0, 0); // Monday 00:00 UTC
      expect(isIdleTime(entries, now, 'UTC')).toBe(true);
    });

    it('returns false at 06:00 UTC (exact end — exclusive)', () => {
      const now = utcDate(2026, 2, 2, 6, 0); // Monday 06:00 UTC
      expect(isIdleTime(entries, now, 'UTC')).toBe(false);
    });

    it('returns true at 05:59 UTC (one minute before end)', () => {
      const now = utcDate(2026, 2, 2, 5, 59); // Monday 05:59 UTC
      expect(isIdleTime(entries, now, 'UTC')).toBe(true);
    });
  });

  // AC2: Overnight ranges (crossing midnight)
  describe('overnight range crossing midnight (AC2)', () => {
    const entries: IdleHoursEntry[] = [{ start: '22:00', end: '06:00' }];

    it('returns true at 23:30 UTC (before midnight)', () => {
      const now = utcDate(2026, 2, 2, 23, 30);
      expect(isIdleTime(entries, now, 'UTC')).toBe(true);
    });

    it('returns true at 02:00 UTC (after midnight)', () => {
      const now = utcDate(2026, 2, 3, 2, 0);
      expect(isIdleTime(entries, now, 'UTC')).toBe(true);
    });

    it('returns false at 12:00 UTC (daytime)', () => {
      const now = utcDate(2026, 2, 2, 12, 0);
      expect(isIdleTime(entries, now, 'UTC')).toBe(false);
    });

    it('returns true at 22:00 UTC (exact start)', () => {
      const now = utcDate(2026, 2, 2, 22, 0);
      expect(isIdleTime(entries, now, 'UTC')).toBe(true);
    });

    it('returns false at 06:00 UTC (exact end — exclusive)', () => {
      const now = utcDate(2026, 2, 3, 6, 0);
      expect(isIdleTime(entries, now, 'UTC')).toBe(false);
    });

    it('returns false at 21:59 UTC (one minute before start)', () => {
      const now = utcDate(2026, 2, 2, 21, 59);
      expect(isIdleTime(entries, now, 'UTC')).toBe(false);
    });
  });

  // AC3: Day-of-week support
  describe('day-of-week filtering (AC3)', () => {
    const entries: IdleHoursEntry[] = [
      { start: '00:00', end: '06:00' },
      { start: '00:00', end: '23:59', days: ['saturday', 'sunday'] },
    ];

    it('returns true on Saturday at 14:00 UTC (weekend rule matches)', () => {
      const now = utcDate(2026, 2, 7, 14, 0); // Saturday
      expect(isIdleTime(entries, now, 'UTC')).toBe(true);
    });

    it('returns true on Sunday at 10:00 UTC (weekend rule matches)', () => {
      const now = utcDate(2026, 2, 8, 10, 0); // Sunday
      expect(isIdleTime(entries, now, 'UTC')).toBe(true);
    });

    it('returns false on Tuesday at 14:00 UTC (no rule matches)', () => {
      const now = utcDate(2026, 2, 3, 14, 0); // Tuesday
      expect(isIdleTime(entries, now, 'UTC')).toBe(false);
    });

    it('returns true on Tuesday at 03:00 UTC (first rule matches regardless of day)', () => {
      const now = utcDate(2026, 2, 3, 3, 0); // Tuesday
      expect(isIdleTime(entries, now, 'UTC')).toBe(true);
    });

    it('returns false on Saturday at 23:59 UTC (end is exclusive)', () => {
      // The weekend rule has end: "23:59", and 23:59 (1439 min) < 1439 is false
      const now = utcDate(2026, 2, 7, 23, 59); // Saturday 23:59
      expect(isIdleTime(entries, now, 'UTC')).toBe(false);
    });
  });

  // AC3 extended: day-of-week only entry
  describe('day-of-week only entry', () => {
    const entries: IdleHoursEntry[] = [
      { start: '09:00', end: '17:00', days: ['monday', 'wednesday', 'friday'] },
    ];

    it('returns true on Monday at 12:00 UTC', () => {
      const now = utcDate(2026, 2, 2, 12, 0); // Monday
      expect(isIdleTime(entries, now, 'UTC')).toBe(true);
    });

    it('returns false on Tuesday at 12:00 UTC', () => {
      const now = utcDate(2026, 2, 3, 12, 0); // Tuesday
      expect(isIdleTime(entries, now, 'UTC')).toBe(false);
    });

    it('returns false on Monday at 08:59 UTC (before start)', () => {
      const now = utcDate(2026, 2, 2, 8, 59); // Monday
      expect(isIdleTime(entries, now, 'UTC')).toBe(false);
    });
  });

  // AC4: Multiple ranges compose with OR
  describe('multiple ranges OR composition (AC4)', () => {
    const entries: IdleHoursEntry[] = [
      { start: '00:00', end: '06:00' },
      { start: '12:00', end: '13:00' },
      { start: '22:00', end: '23:00' },
    ];

    it('returns true in first range at 03:00 UTC', () => {
      expect(isIdleTime(entries, utcDate(2026, 2, 2, 3, 0), 'UTC')).toBe(true);
    });

    it('returns true in second range at 12:30 UTC', () => {
      expect(isIdleTime(entries, utcDate(2026, 2, 2, 12, 30), 'UTC')).toBe(true);
    });

    it('returns true in third range at 22:15 UTC', () => {
      expect(isIdleTime(entries, utcDate(2026, 2, 2, 22, 15), 'UTC')).toBe(true);
    });

    it('returns false at 10:00 UTC (between ranges)', () => {
      expect(isIdleTime(entries, utcDate(2026, 2, 2, 10, 0), 'UTC')).toBe(false);
    });

    it('returns false at 18:00 UTC (between ranges)', () => {
      expect(isIdleTime(entries, utcDate(2026, 2, 2, 18, 0), 'UTC')).toBe(false);
    });
  });

  // AC5: Empty or missing idle_hours
  describe('empty entries (AC5)', () => {
    it('returns false with empty array', () => {
      expect(isIdleTime([], new Date(), 'UTC')).toBe(false);
    });
  });

  // AC6: Boundary times
  describe('boundary times (AC6)', () => {
    const entries: IdleHoursEntry[] = [{ start: '09:00', end: '17:00' }];

    it('returns true at exact start time', () => {
      const now = utcDate(2026, 2, 2, 9, 0);
      expect(isIdleTime(entries, now, 'UTC')).toBe(true);
    });

    it('returns false at exact end time (exclusive)', () => {
      const now = utcDate(2026, 2, 2, 17, 0);
      expect(isIdleTime(entries, now, 'UTC')).toBe(false);
    });

    it('returns true one minute after start', () => {
      const now = utcDate(2026, 2, 2, 9, 1);
      expect(isIdleTime(entries, now, 'UTC')).toBe(true);
    });

    it('returns true one minute before end', () => {
      const now = utcDate(2026, 2, 2, 16, 59);
      expect(isIdleTime(entries, now, 'UTC')).toBe(true);
    });
  });

  // AC7: Injectable timezone
  describe('injectable timezone (AC7)', () => {
    it('evaluates against explicit UTC timezone', () => {
      const entries: IdleHoursEntry[] = [{ start: '00:00', end: '06:00' }];
      const now = utcDate(2026, 2, 2, 3, 0); // 03:00 UTC
      expect(isIdleTime(entries, now, 'UTC')).toBe(true);
    });

    it('evaluates against America/New_York timezone (UTC-5 in March)', () => {
      // March 2 2026 is before US DST (starts Mar 8), so EST = UTC-5
      const entries: IdleHoursEntry[] = [{ start: '22:00', end: '23:00' }];
      // 03:00 UTC = 22:00 EST (UTC-5)
      const now = utcDate(2026, 2, 2, 3, 0);
      expect(isIdleTime(entries, now, 'America/New_York')).toBe(true);
    });

    it('returns false when timezone shifts time outside range', () => {
      const entries: IdleHoursEntry[] = [{ start: '00:00', end: '06:00' }];
      // 03:00 UTC = 22:00 previous day in America/New_York (UTC-5)
      const now = utcDate(2026, 2, 2, 3, 0);
      expect(isIdleTime(entries, now, 'America/New_York')).toBe(false);
    });

    it('evaluates day-of-week in the specified timezone', () => {
      const entries: IdleHoursEntry[] = [{ start: '00:00', end: '23:59', days: ['saturday'] }];
      // Saturday 2026-03-07 23:00 UTC = Saturday 18:00 EST
      const now = utcDate(2026, 2, 7, 23, 0);
      expect(isIdleTime(entries, now, 'America/New_York')).toBe(true);
    });

    it('day-of-week changes across timezone boundary', () => {
      const entries: IdleHoursEntry[] = [{ start: '00:00', end: '23:59', days: ['sunday'] }];
      // Sunday 2026-03-08 02:00 UTC = Saturday 2026-03-07 21:00 EST (still Saturday in NYC)
      const now = utcDate(2026, 2, 8, 2, 0);
      expect(isIdleTime(entries, now, 'UTC')).toBe(true); // Sunday in UTC
      expect(isIdleTime(entries, now, 'America/New_York')).toBe(false); // Saturday in EST
    });

    it('uses system timezone when timezone parameter is omitted', () => {
      // This test verifies the function runs without error when timezone is undefined.
      // We can't assert a specific result since system timezone varies.
      const entries: IdleHoursEntry[] = [{ start: '00:00', end: '06:00' }];
      const result = isIdleTime(entries, new Date());
      expect(typeof result).toBe('boolean');
    });

    it('throws ScrowError with IDLE_HOURS_INVALID_TIMEZONE for invalid timezone string', () => {
      const entries: IdleHoursEntry[] = [{ start: '00:00', end: '06:00' }];
      expect(() => isIdleTime(entries, new Date(), 'Not/A_Timezone')).toThrow(
        expect.objectContaining({ code: 'IDLE_HOURS_INVALID_TIMEZONE' }),
      );
    });
  });

  // Edge case: overnight range with day-of-week
  describe('overnight range with day-of-week', () => {
    const entries: IdleHoursEntry[] = [{ start: '22:00', end: '06:00', days: ['friday'] }];

    it('returns true on Friday at 23:00 UTC', () => {
      // 2026-03-06 is a Friday
      const now = utcDate(2026, 2, 6, 23, 0);
      expect(isIdleTime(entries, now, 'UTC')).toBe(true);
    });

    it('returns false on Saturday at 02:00 UTC (day check evaluates at current day)', () => {
      // 2026-03-07 is a Saturday; the day filter requires Friday
      // Even though this would be "within" the overnight range started on Friday,
      // the day check is based on the current day (Saturday), not the range start day
      const now = utcDate(2026, 2, 7, 2, 0);
      expect(isIdleTime(entries, now, 'UTC')).toBe(false);
    });

    it('returns false on Thursday at 23:00 UTC', () => {
      // 2026-03-05 is a Thursday
      const now = utcDate(2026, 2, 5, 23, 0);
      expect(isIdleTime(entries, now, 'UTC')).toBe(false);
    });
  });

  // Full 24-hour window with same start/end
  describe('full 24-hour window (start === end)', () => {
    const entries: IdleHoursEntry[] = [{ start: '00:00', end: '00:00' }];

    it('returns true at 00:00 (full day)', () => {
      expect(isIdleTime(entries, utcDate(2026, 2, 2, 0, 0), 'UTC')).toBe(true);
    });

    it('returns true at 12:00 (full day)', () => {
      expect(isIdleTime(entries, utcDate(2026, 2, 2, 12, 0), 'UTC')).toBe(true);
    });

    it('returns true at 23:59 (full day)', () => {
      expect(isIdleTime(entries, utcDate(2026, 2, 2, 23, 59), 'UTC')).toBe(true);
    });

    it('works with day-of-week filter for all-day idle on specific days', () => {
      const weekendEntries: IdleHoursEntry[] = [
        { start: '00:00', end: '00:00', days: ['saturday', 'sunday'] },
      ];
      // Saturday
      expect(isIdleTime(weekendEntries, utcDate(2026, 2, 7, 14, 0), 'UTC')).toBe(true);
      // Monday
      expect(isIdleTime(weekendEntries, utcDate(2026, 2, 2, 14, 0), 'UTC')).toBe(false);
    });
  });

  // Near full-day range (23:59 gap)
  describe('near full-day range', () => {
    const entries: IdleHoursEntry[] = [{ start: '00:00', end: '23:59' }];

    it('returns true at 00:00', () => {
      expect(isIdleTime(entries, utcDate(2026, 2, 2, 0, 0), 'UTC')).toBe(true);
    });

    it('returns true at 12:00', () => {
      expect(isIdleTime(entries, utcDate(2026, 2, 2, 12, 0), 'UTC')).toBe(true);
    });

    it('returns false at 23:59 (end is exclusive)', () => {
      expect(isIdleTime(entries, utcDate(2026, 2, 2, 23, 59), 'UTC')).toBe(false);
    });
  });
});
