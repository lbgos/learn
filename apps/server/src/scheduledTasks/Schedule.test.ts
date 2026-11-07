import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { isMissedFixedTimeRun, isSameSchedule, nextScheduledRunAt } from "./Schedule.ts";

describe("scheduled task schedule calculation", () => {
  it("runs one-time reminders only at their timezone-qualified instant", () => {
    const schedule = { type: "once", runAt: "2026-10-28T18:00:00+02:00" } as const;
    const due = DateTime.makeUnsafe("2026-10-28T16:00:00Z");
    expect(
      DateTime.toEpochMillis(nextScheduledRunAt(schedule, DateTime.subtract(due, { seconds: 1 }))!),
    ).toBe(DateTime.toEpochMillis(due));
    expect(nextScheduledRunAt(schedule, due)).toBeNull();
    expect(nextScheduledRunAt(schedule, DateTime.add(due, { days: 1 }))).toBeNull();
    expect(isSameSchedule(schedule, { type: "once", runAt: "2026-10-28T16:00:00Z" })).toBe(true);
    expect(isSameSchedule(schedule, { type: "fixed_time", timeOfDay: "18:00" })).toBe(false);
    expect(isMissedFixedTimeRun(schedule, due, DateTime.add(due, { days: 1 }))).toBe(false);
  });
  it("skips to the next matching fixed-time weekday", () => {
    const next = nextScheduledRunAt(
      { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
      DateTime.makeZonedUnsafe(
        {
          year: 2026,
          month: 7,
          day: 3,
          hour: 10,
          minute: 0,
          second: 0,
          millisecond: 0,
        },
        { timeZone: "America/Los_Angeles", adjustForTimeZone: true },
      ),
    );
    const parts = next ? DateTime.toParts(next) : null;
    expect(parts?.weekDay).toBe(1);
    expect(parts?.hour).toBe(9);
    expect(parts?.minute).toBe(0);
  });

  it("compares schedules structurally", () => {
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 60_000 }),
    ).toBe(true);
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 30_000 }),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [5, 1] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 5, 5] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [] },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 3] },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:30" },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "interval", everyMs: 60_000 },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(false);
  });
});
