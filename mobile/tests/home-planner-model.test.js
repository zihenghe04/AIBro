import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { plannerDayKey, plannerDayBounds, plannerWeek, shiftPlannerDay, plannerTasks, plannerEvents, plannerEventTime, taskDue } from "../src/ui/home-planner-model.js";

test("selected week follows a distant date rather than today, with unique current and selected flags", () => {
  const days = plannerWeek("2030-12-01", "2030-01-07");
  assert.deepEqual(days.map(day => day.key), ["2030-11-25", "2030-11-26", "2030-11-27", "2030-11-28", "2030-11-29", "2030-11-30", "2030-12-01"]);
  assert.equal(days.filter(day => day.today).length, 0);
  assert.equal(days.find(day => day.selected).key, "2030-12-01");
  assert.equal(plannerWeek("2030-01-07", "2030-01-07")[0].today, true);
});

test("week navigation crosses year and leap boundaries, malformed dates never normalize silently", () => {
  assert.equal(shiftPlannerDay("2028-02-28", 1), "2028-02-29");
  assert.equal(shiftPlannerDay("2030-01-01", -7), "2029-12-25");
  for (const invalid of ["2026-02-29", "2030-13-01", "2030-01-00", "bad", "", null]) assert.equal(plannerDayKey(invalid), null);
});

test("calendar days and date-only deadlines stay local across negative UTC offsets and DST", () => {
  const url = new URL("../src/ui/home-planner-model.js", import.meta.url).href;
  const script = `import {plannerDayKey,plannerDayBounds,shiftPlannerDay,taskDue} from ${JSON.stringify(url)};const b=plannerDayBounds('2026-03-08'); console.log(JSON.stringify({day:plannerDayKey('2026-03-08'),next:shiftPlannerDay('2026-03-08',1),hours:(b.to-b.from)/3600000,due:taskDue({dueAt:'2026-03-08'}).day,midnight:new Date(b.from).getHours()}))`;
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, TZ: "America/Los_Angeles" }, encoding: "utf8" }));
  assert.deepEqual(result, { day: "2026-03-08", next: "2026-03-09", hours: 23, due: "2026-03-08", midnight: 0 });
});

test("pending tasks retain independent unscheduled work, overdue, today and future while excluding archived/deleted/completed", () => {
  const input = [
    { id: "future", dueAt: "2030-01-10", status: "doing" },
    { id: "unscheduled", status: "todo" },
    { id: "today", dueAt: "2030-01-07", status: "blocked" },
    { id: "late", dueAt: "2030-01-01", status: "todo" },
    { id: "done", status: "done" }, { id: "archived", archived: true }, { id: "deleted", deletedAt: 12 },
    { id: "invalid-date", dueAt: "not-a-date" },
  ];
  const original = structuredClone(input);
  const groups = plannerTasks(input, { today: "2030-01-07" });
  assert.deepEqual(groups.map(group => [group.key, group.rows.map(({ task }) => task.id)]), [["overdue", ["late"]], ["today", ["today"]], ["upcoming", ["future"]], ["unscheduled", ["invalid-date", "unscheduled"]]]);
  assert.deepEqual(input, original);
});

test("completed filter exposes only active completed records in recent-completion order", () => {
  const groups = plannerTasks([{ id: "old", status: "done", completedAt: 12 }, { id: "new", status: "done", completedAt: 99 }, { id: "todo" }, { id: "hidden", status: "done", archived: true }], { today: "2030-01-07", showCompleted: true });
  assert.deepEqual(groups.map(group => [group.key, group.rows.map(({ task }) => task.id)]), [["completed", ["new", "old"]]]);
});

test("agenda filters overlapping occurrences for selected day with end-exclusive midnight and deterministic all-day-first order", () => {
  const { from, to } = plannerDayBounds("2030-01-07");
  const events = [
    { id: "timed", start: from + 9 * 3600000, end: from + 10 * 3600000 },
    { id: "all", start: from, end: to, allDay: true },
    { id: "continued", start: from - 3600000, end: from + 3600000 },
    { id: "before", start: from - 3600000, end: from },
    { id: "after", start: to, end: to + 3600000 },
    { id: "bad", start: "2030-01-07", end: to },
    { id: "deleted", start: from, end: to, deleted: true },
  ];
  assert.deepEqual(plannerEvents(events, "2030-01-07").map(event => event.id), ["all", "continued", "timed"]);
  assert.equal(plannerEventTime(events[1], "2030-01-07").start, "全天");
  assert.equal(taskDue({ dueAt: "2030-02-31" }), null);
});
