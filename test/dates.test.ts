import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, decideDue, isIsoDate, localToUtc, nextWeekday, todayIn, toWeekday, weekdayOf } from "../server/pipeline/dates.ts";

test("today is the user's today, not UTC's", () => {
  const at = new Date("2026-10-30T22:30:00Z"); // 01:30 on the 31st in Istanbul, 08:30 on the 31st in Brisbane
  assert.equal(todayIn("Europe/Istanbul", at), "2026-10-31");
  assert.equal(todayIn("Australia/Brisbane", at), "2026-10-31");
  assert.equal(todayIn("America/Los_Angeles", at), "2026-10-30");
});

test("a bare weekday is its next occurrence, never today", () => {
  assert.equal(weekdayOf("2026-10-30"), "friday");
  assert.equal(nextWeekday("2026-10-30", "monday"), "2026-11-02");
  assert.equal(nextWeekday("2026-10-30", "friday"), "2026-11-06");
  assert.equal(nextWeekday("2026-10-30", "saturday"), "2026-10-31");
});

test("default dates skip the weekend", () => {
  assert.equal(toWeekday("2026-10-31"), "2026-11-02");
  assert.equal(toWeekday("2026-11-01"), "2026-11-02");
  assert.equal(toWeekday("2026-11-03"), "2026-11-03");
});

test("decideDue: stated wins, past clamps to today, absurd is dropped with a reason, none uses the default", () => {
  const today = "2026-10-30";
  assert.deepEqual(decideDue("2026-11-04", today, 2), { due_on: "2026-11-04", source: "stated" });
  assert.deepEqual(decideDue("2026-10-01", today, 2), { due_on: today, source: "stated" });
  assert.deepEqual(decideDue(null, today, 2), { due_on: "2026-11-02", source: "default" }); // Fri + 2 = Sun -> Mon
  const far = decideDue("2031-01-01", today, 3);
  assert.equal(far.source, "default");
  assert.ok("dropped" in far && far.dropped?.reason.includes("18 months"));
  const bogus = decideDue("2026-02-30", today, 1);
  assert.equal(bogus.source, "default");
  assert.ok("dropped" in bogus && bogus.dropped);
});

test("isIsoDate rejects impossible dates", () => {
  assert.ok(isIsoDate("2028-02-29"));
  assert.ok(!isIsoDate("2026-02-29"));
  assert.ok(!isIsoDate("30/10/2026"));
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("localToUtc honours the zone, including across a DST change", () => {
  assert.equal(localToUtc("2026-10-30", "17:00", "Europe/Istanbul").toISOString(), "2026-10-30T14:00:00.000Z");
  assert.equal(localToUtc("2026-10-30", "17:00", "Australia/Brisbane").toISOString(), "2026-10-30T07:00:00.000Z");
  assert.equal(localToUtc("2026-07-01", "09:00", "Europe/London").toISOString(), "2026-07-01T08:00:00.000Z");
  assert.equal(localToUtc("2026-12-01", "09:00", "Europe/London").toISOString(), "2026-12-01T09:00:00.000Z");
});
