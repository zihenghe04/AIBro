import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Store, MemoryAdapter } from "../src/store.js";
import { eventsFor, readEvent, agendaNote } from "../src/agenda.js";
const run = promisify(execFile);
test("mobile expands exact recurrence fixtures from the real Mac engine and preserves them through edits", async () => {
  const temp = await mkdtemp(join(tmpdir(), "aibro-agenda-fixtures-"));
  try {
    const root = resolve(".."),
      binary = join(temp, "agenda-tests"),
      file = join(temp, "fixtures.json");
    await run("xcrun", [
      "swiftc",
      join(root, "native/Sources/AIBro/AgendaCore.swift"),
      join(root, "native/Sources/AIBro/AgendaSync.swift"),
      join(root, "tests/agenda-sync.swift"),
      "-o",
      binary,
    ]);
    const { stdout } = await run(binary, [file]);
    assert.match(stdout, /PASS 14/);
    const fixtures = JSON.parse(await readFile(file, "utf8"));
    for (const fixture of fixtures) {
      const store = await new Store(new MemoryAdapter()).load();
      await store.put("notes", fixture.note);
      const rows = eventsFor(store, fixture.from, fixture.to);
      assert.deepEqual(
        rows.map(({ start, end }) => ({ start, end })),
        fixture.occurrences,
        fixture.note.title + " " + readEvent(fixture.note).timeZone,
      );
      const event = readEvent(fixture.note);
      const edited = agendaNote(
        { ...event, title: "手机改标题", location: "实验室" },
        fixture.note,
      );
      await store.put("notes", edited);
      assert.deepEqual(
        eventsFor(store, fixture.from, fixture.to).map(({ start, end }) => ({
          start,
          end,
        })),
        fixture.occurrences,
      );
      if (event.completed.includes(event.start))
        assert.equal(rows[0].reminderAt, null);
      await store.put("notes", agendaNote({ ...event, deleted: true }, edited));
      assert.equal(eventsFor(store, fixture.from, fixture.to).length, 0);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
