import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { Store, MemoryAdapter } from "../src/store.js";
import { ask } from "../src/ai.js";
import { fetchModelStream } from "../src/model-stream.js";

// Validate the embedded XCTest provider against the actual tool/stream contract
// before paying for a native build. This is not WebKit or native acceptance.
test("iOS bundled-WebKit fixture feeds real Responses tools and preserves approval boundary", async () => {
  const source = await readFile(new URL("../ios/App/AppTests/MobileNativeTests.swift", import.meta.url), "utf8");
  const script = source.match(/static let responsesFixtureScript = #"""\n([\s\S]*?)\n\s*"""#/);
  assert.ok(script, "XCTest synthetic provider source exists");
  const window = { fetch: async () => { throw Error("No external request is allowed in fixture validation"); } };
  vm.runInNewContext(script[1], { window, Response, ReadableStream, TextEncoder, setTimeout });
  const store = await new Store(new MemoryAdapter()).load();
  await store.tx(state => { state.settings.model = { base: "https://responses.fixture.invalid/v1", model: "qa-ios-responses", format: "responses" }; });
  await store.put("conversations", { id: "synthetic", title: "原生准备", projectId: null });
  const result = await ask({ store, conversationID: "synthetic", prompt: "创建一个合成任务，先让我确认。",
    vault: { get: async () => "synthetic-ios-responses-key" },
    stream: (url, options) => fetchModelStream(window.fetch, url, options) });
  assert.equal(window.__responsesRequests, 2); // Complete plan ends before optional prose.
  assert.equal(result.pendingPlan.status, "pending");
  assert.equal(result.pendingPlan.actions[0].after.title, "合成 iOS Responses 任务");
  assert.equal(store.list("tasks").length, 0);
  assert.doesNotMatch(JSON.stringify(store.state), /qa-ios-opaque|synthetic-ios-responses-key|我已替你保存/);
});
