// Responses items stay in memory for this turn, including opaque reasoning
// content. Only provider-visible text/summary enters the saved conversation.
const clone = value => structuredClone(value);
const bad = () => Error("模型工具流不完整或前后不一致，未执行本轮工具");
const supported = new Set(["message", "reasoning", "function_call"]);
export function responseTools(definitions) {
  // Existing schemas intentionally have optional fields; do not normalize them
  // into strict-mode required fields and change the workspace tool contract.
  return definitions.map(({ function: fn }) => ({ type: "function", ...fn, strict: false }));
}
export function createResponsesOutput(emit) {
  const items = new Map(), streamed = new Map(), parts = new Map();
  const legacy = { text: false, reasoning: false };
  let text = "", reasoning = "", complete = false, output = null;
  const append = (kind, value) => {
    if (typeof value !== "string" || !value) return;
    if (kind === "text") text += value; else reasoning += value;
    emit({ type: kind, text: value });
  };
  const indexOf = event => {
    if (!Number.isSafeInteger(event.output_index) || event.output_index < 0 || event.output_index > 63) throw bad();
    return event.output_index;
  };
  const partIndex = value => {
    if (!Number.isSafeInteger(value) || value < 0 || value > 4095) throw bad();
    return value;
  };
  function acceptPart(index, position, channel, itemID, value, done, delta = false) {
    if (typeof value !== "string") throw bad();
    const kind = channel === "text" || channel === "refusal" ? "text" : "reasoning";
    const item = items.get(index);
    if (item && (item.item.type !== (kind === "text" ? "message" : "reasoning") ||
        itemID && item.item.id !== itemID || delta && item.done)) throw bad();
    const key = `${index}:${channel === "refusal" ? "text" : channel}:${position}`;
    const previous = parts.get(key);
    if (previous && (previous.channel !== channel || previous.itemID && itemID && previous.itemID !== itemID ||
        delta && previous.done)) throw bad();
    const prior = previous?.value || "";
    const next = delta ? prior + value : value;
    if (!delta && (!next.startsWith(prior) || previous?.done && next !== prior)) throw bad();
    if (next.length > 2 * 1024 * 1024) throw Error("模型单轮工具结果过大");
    parts.set(key, { index, position, channel, kind, itemID: itemID || previous?.itemID, value: next, done });
  }
  function visible(kind, final = false) {
    const values = [];
    const indices = [...items.keys(), ...[...parts.values()].map(part => part.index)];
    const last = indices.length ? Math.max(...indices) : -1;
    // Buffer later items/parts until earlier ones finish. Concatenating deltas
    // by arrival order could permanently reverse two output messages.
    outer: for (let index = 0; index <= last; index++) {
      const row = items.get(index), current = [...parts.values()].filter(part => part.index === index);
      if (!row && !current.length) break;
      const relevant = current.filter(part => part.kind === kind)
        .sort((a, b) => a.position - b.position || a.channel.localeCompare(b.channel));
      let expected = 0;
      for (const part of relevant) {
        if (part.position > expected && !row?.done && !final) break outer;
        expected = part.position + 1;
        if (part.value) values.push(part.value);
        if (!part.done && !final) break outer;
      }
      if (!row?.done && !final) break;
    }
    return values.join(kind === "reasoning" ? "\n" : "");
  }
  function reconcile(kind, value) {
    const received = kind === "text" ? text : reasoning;
    if (!value.startsWith(received)) throw bad();
    append(kind, value.slice(received.length));
  }
  function flush() {
    for (const kind of ["text", "reasoning"]) if (!legacy[kind]) reconcile(kind, visible(kind));
  }
  function acceptTextEvent(event) {
    const channel = event.type.includes("refusal") ? "refusal" : event.type.includes("reasoning_summary") ? "summary"
      : event.type.includes("reasoning_text") ? "raw" : "text";
    const kind = channel === "text" || channel === "refusal" ? "text" : "reasoning";
    const done = event.type.endsWith(".done"), value = done ? event.text ?? event.refusal : event.delta;
    // Some compatible endpoints omit item/index metadata for text-only output.
    // Keep that path, but still reconcile its prefix against any final body.
    if (event.output_index === undefined && event.item_id === undefined) {
      if (typeof value !== "string" || [...parts.values()].some(part => part.kind === kind)) throw bad();
      legacy[kind] = true;
      if (done) reconcile(kind, value); else append(kind, value);
    } else acceptPart(indexOf(event), partIndex(channel === "summary" ? event.summary_index : event.content_index),
      channel, event.item_id, value, done, !done);
  }
  function acceptItem(index, item, done) {
    if (!item || !supported.has(item.type)) throw Error("模型返回了此连接未开放的工具类型，未执行本轮工具");
    const previous = items.get(index);
    if (previous && (previous.item.type !== item.type || previous.item.id !== item.id)) throw bad();
    if (previous?.done && !done) throw bad();
    if (item.type === "function_call") {
      if (previous && (previous.item.call_id !== item.call_id || previous.item.name !== item.name)) throw bad();
      if (typeof item.arguments !== "string" || item.arguments.length > 200000) throw bad();
      const partial = streamed.get(index);
      if (done && partial && partial.arguments !== item.arguments) throw bad();
      if (previous?.done && previous.item.arguments !== item.arguments) throw bad();
    }
    const currentParts = [...parts.values()].filter(part => part.index === index);
    if (currentParts.some(part => part.itemID && part.itemID !== item.id ||
        item.type !== (part.kind === "text" ? "message" : "reasoning"))) throw bad();
    if (done && item.type !== "function_call") {
      const content = item.type === "message" ? item.content || [] : item.summary || [];
      if (!Array.isArray(content) || content.length > 4096) throw bad();
      const present = new Set();
      content.forEach((part, position) => {
        const channel = part.type === "output_text" ? "text" : part.type === "refusal" ? "refusal"
          : part.type === "summary_text" ? "summary" : null;
        if (!channel) return;
        present.add(`${channel}:${position}`);
        acceptPart(index, position, channel, item.id, channel === "refusal" ? part.refusal : part.text, true);
      });
      // Raw reasoning deltas are a compatibility extension; an empty summary
      // does not contradict them. Explicit message/summary parts are complete.
      if (currentParts.some(part => part.channel !== "raw" && !present.has(`${part.channel}:${part.position}`))) throw bad();
    }
    items.set(index, { item: clone(item), done });
  }
  function consume(event, streaming = true) {
    if (complete) return;
    if (/^response\.(output_text|refusal|reasoning_summary_text|reasoning_text)\.(delta|done)$/.test(event.type)) acceptTextEvent(event);
    else if (["response.output_item.added", "response.output_item.done"].includes(event.type)) {
      acceptItem(indexOf(event), event.item, event.type.endsWith(".done"));
    } else if (["response.function_call_arguments.delta", "response.function_call_arguments.done"].includes(event.type)) {
      const index = indexOf(event), row = items.get(index);
      if (!row || row.done || row.item.type !== "function_call" || row.item.id !== event.item_id) throw bad();
      const partial = streamed.get(index) || { arguments: row.item.arguments || "", done: false };
      if (partial.done) throw bad();
      if (event.type.endsWith(".delta")) {
        if (typeof event.delta !== "string") throw bad();
        partial.arguments += event.delta;
      } else {
        if (typeof event.arguments !== "string" || partial.arguments && partial.arguments !== event.arguments) throw bad();
        partial.arguments = event.arguments; partial.done = true;
      }
      if (partial.arguments.length > 200000) throw bad();
      streamed.set(index, partial);
    } else if (event.type === "response.completed" || !streaming || Array.isArray(event.output)) {
      const response = event.response || event;
      if (response.status && response.status !== "completed") throw Error("模型未完成本次回答");
      if (Array.isArray(response.output)) {
        if (response.output.length > 64) throw bad();
        response.output.forEach((item, index) => acceptItem(index, item, true));
        if ([...items.keys(), ...[...parts.values()].map(part => part.index)].some(index => index >= response.output.length)) throw bad();
        output = clone(response.output);
      } else {
        const rows = [...items.entries()].sort(([a], [b]) => a - b);
        if (rows.some(([index, row], position) => index !== position || !row.done)) throw bad();
        if ([...parts.values()].some(part => !items.get(part.index)?.done)) throw bad();
        output = rows.map(([, row]) => row.item);
      }
      if (JSON.stringify(output).length > 2 * 1024 * 1024) throw Error("模型单轮工具结果过大");
      for (const kind of ["text", "reasoning"]) {
        const hasParts = [...parts.values()].some(part => part.kind === kind);
        if (hasParts) reconcile(kind, visible(kind, true));
        else if (kind === "text" && typeof response.output_text === "string") reconcile(kind, response.output_text);
      }
      if (typeof response.output_text === "string" && [...parts.values()].some(part => part.kind === "text") && response.output_text !== text) throw bad();
      complete = true;
    }
    if (!complete) flush();
  }
  function result() {
    if (!complete) throw Error("模型流在完成前中断，已保留收到的内容");
    const calls = output.filter(item => item.type === "function_call"), seen = new Set();
    for (const item of calls) {
      if (typeof item.call_id !== "string" || !item.call_id || seen.has(item.call_id) ||
          typeof item.name !== "string" || !item.name || typeof item.arguments !== "string" ||
          item.arguments.length > 200000 || item.status && item.status !== "completed") throw bad();
      seen.add(item.call_id);
    }
    return { text, reasoning, responseOutput: output,
      toolCalls: calls.map(item => ({ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } })) };
  }
  return { consume, result };
}
