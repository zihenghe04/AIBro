/* Bounded, ephemeral parser workspaces. No rendered citations or user records
 * are cached here. Eviction changes performance only, never message content. */
(function (root, factory) {
  const api = factory(root, typeof module === 'object' && module.exports ? require('./stream-code.js') : root.StreamCode);
  root.StreamMarkdown = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, (root, Code) => {
  'use strict';
  function create({ maxEntries = 4, maxCharacters = 2 * 1024 * 1024 } = {}) {
    const entries = new Map();
    const frontier = root.ConversationStreamBody?.create({maxEntries,maxCharacters});
    // A mounted active body keeps a reference to its last accepted raw string
    // for exact append validation. Unlike the bounded parser pool, this state
    // grows with visible content; WeakMap ownership and canonical adoption
    // release it with the body. It is never a second persistent transcript.
    let bodies = new WeakMap(), plans = new WeakMap(), tokens = new WeakMap();
    // Settled flow prose belongs to its mounted DOM, not the four-entry active
    // parser pool. No strong owner registry or cumulative HTML snapshots: when
    // the transcript releases a body, its observer and memo can be collected.
    let settledBodies = new WeakMap(), settledPlans = new WeakMap();
    const owned = '[data-safe-preview], [data-preview-action], .safe-preview-restore, [data-halaska-root], [data-halaska-conversation], [data-citation-panel]';
    const weight = entry => (entry.cache.source?.length || 0) + (entry.cache.prefix?.length || 0) + (entry.text?.length || 0) + (entry.html?.length || 0);
    const size = () => [...entries.values()].reduce((sum, entry) => sum + weight(entry), 0);
    function release(owner) { entries.delete(owner); frontier?.release(owner); if (owner && typeof owner === 'object') tokens.delete(owner); }
    function token(owner) { if (!tokens.has(owner)) tokens.set(owner, {}); return tokens.get(owner); }
    function render(owner, text, renderer, live = false, metadata = null) {
      if (!live || !owner || typeof owner !== 'object') {
        release(owner);
        return renderer(text);
      }
      let entry = entries.get(owner);
      const plain = !!metadata?.liveCode;
      if (!entry || entry.renderer !== renderer || entry.plain !== plain) entry = { renderer, plain, cache: {} };
      entry.cache.liveCode = plain;
      entries.delete(owner);
      // The actual parser owns its block boundaries. This adapter never scans
      // Markdown or keeps a second grammar that could disagree during a stream.
      // Tool/reasoning events can repaint a message without changing its body.
      // Reuse only undecorated parser output, after the parser explicitly
      // reports unchanged dependencies. Citations/permissions are still bound
      // from current state by renderBody; final output always parses afresh.
      let reusable = false;
      if (entry.text === text && typeof entry.html === 'string' && Array.isArray(entry.cache.dependencies)) {
        const probe = { probeOnly: true }; renderer('', null, probe);
        reusable = Array.isArray(probe.dependencies) && probe.dependencies.length === entry.cache.dependencies.length &&
          probe.dependencies.every((value, index) => value === entry.cache.dependencies[index]);
      }
      const html = reusable ? entry.html : renderer(text, null, entry.cache);
      entry.text = text; entry.html = html;
      if (metadata) { metadata.fence = entry.cache.fence; metadata.dependencies = entry.cache.dependencies; metadata.prefix = entry.cache.prefix; }
      entries.set(owner, entry);
      while (entries.size && (entries.size > maxEntries || size() > maxCharacters)) {
        entries.delete(entries.keys().next().value);
      }
      return html;
    }

    function citationRefresh(body, context) {
      const api = root.CitationEvidence;
      if (!context || !api) return () => {};
      if (body.querySelector('[data-citation-invalid]') || !api.sourcesFor || !api.bind) return null;
      const sources = api.sourcesFor(context.message, context.run, context.state), bindings = [];
      for (const node of body.querySelectorAll('[data-citation-source]')) {
        const source = sources.find(value => value.sourceId === node.dataset.citationSource && (value.runId || '') === node.dataset.citationRun);
        if (!source) return null;
        bindings.push({ node, source });
      }
      for (const link of body.querySelectorAll('a[href]:not([data-citation-linked])')) {
        let href; try { href = new URL(link.getAttribute('href')).href; } catch (_) { continue; }
        if (sources.some(source => source.url === href)) return null;
      }
      return () => {
        const english = root.WorkstationI18n?.getLanguage?.() === 'en';
        for (const { node, source } of bindings) {
          api.bind(node, source, sources);
          const value = String(source.number || '↗'); if (node.textContent !== value) node.textContent = value;
          node.setAttribute('aria-label', english ? `Inspect source ${source.number || ''}: ${source.title}` : `查看来源 ${source.number || ''}：${source.title}`);
        }
      };
    }
    function validBody(body, state) {
      return body?.isConnected && state && state.token === tokens.get(state.owner) &&
        body.lastElementChild === state.code?.parentElement && state.code.parentElement?.matches('pre.message-code') &&
        state.code === state.code.parentElement.lastElementChild &&
        !body.querySelector(owned) && [...state.code.childNodes].every(node => node.nodeType === 3);
    }
    function sameDependencies(state) {
      const probe = { probeOnly: true }; state.renderer('', null, probe);
      return probe.dependencies?.length === state.dependencies?.length &&
        probe.dependencies.every((value, i) => value === state.dependencies[i]);
    }
    function forgetSettled(body) {
      settledBodies.get(body)?.observer.disconnect(); settledBodies.delete(body);
    }
    function settledValid(body, state) {
      if (!body?.isConnected || !state || settledBodies.get(body) !== state || state.token !== tokens.get(state.owner)) return false;
      if (state.observer.takeRecords().length) state.dirty = true;
      return !state.dirty && sameDependencies(state);
    }
    function rememberSettled(body, value) {
      forgetSettled(body);
      if (typeof root.MutationObserver !== 'function') return;
      const probe = { probeOnly: true }; value.renderer('', null, probe);
      if (!Array.isArray(probe.dependencies)) return;
      const state = { ...value, dependencies: probe.dependencies, token: token(value.owner), dirty: false };
      state.observer = new root.MutationObserver(() => { state.dirty = true; });
      state.observer.observe(body, { subtree: true, childList: true, characterData: true, attributes: true });
      settledBodies.set(body, state);
    }
    function renderBody(owner, host, value, renderer, options = {}) {
      const text = String(value ?? ''), previous = options.previous, old = bodies.get(previous);
      function complete() {
        const metadata = { liveCode: !!options.live };
        const html=render(owner, text, renderer, !!options.live, metadata);
        const staged=options.live&&frontier?.stage({owner,previous,host,html,text,prefix:metadata.prefix,dependencies:metadata.dependencies,
          refresh:previous?citationRefresh(previous,options.citations):null,decorate:options.decorate});
        if(!staged){host.innerHTML=html;options.decorate?.(host);}
        if (options.retainSettled && !options.live && owner && typeof owner === 'object') rememberSettled(host, { owner, text, renderer });
        const code = host.lastElementChild?.matches('pre.message-code') ? host.lastElementChild.lastElementChild : null;
        if (Code && metadata.fence && code?.nodeName === 'CODE') {
          const continuation = Code.seed(metadata.fence, text);
          bodies.set(host, { owner, renderer, token: token(owner), dependencies: metadata.dependencies, code, continuation,
            commits: old?.commits || 0, fullRenders: (old?.fullRenders || 0) + 1,
            scannedCharacters: (old?.scannedCharacters || 0) + text.length, appendedCharacters: old?.appendedCharacters || 0,
            validatedCharacters: old?.validatedCharacters || 0 });
        } else bodies.delete(host);
      }
      const settled = settledBodies.get(previous);
      if (options.retainSettled && !options.live && settled?.owner === owner && settled.renderer === renderer && settled.text === text
        && settledValid(previous, settled) && citationRefresh(previous, options.citations)) {
        settledPlans.set(host, { previous, settled, complete, citations: options.citations });
        return 'planned';
      }
      if (options.live && Code && old?.owner === owner && old.renderer === renderer && validBody(previous, old)) {
        const refresh = citationRefresh(previous, options.citations);
        if (refresh && sameDependencies(old)) {
          const change = Code.advance(old.continuation, text);
          if (change) {
            plans.set(host, { previous, old, change, complete, citations: options.citations });
            return 'planned';
          }
        }
      }
      if (options.live && frontier?.unchanged({ owner, previous, host, text, fallback: complete, verify: dependencies => {
        const probe = { probeOnly: true }; renderer('', null, probe);
        return Array.isArray(probe.dependencies) && probe.dependencies.length === dependencies?.length &&
          probe.dependencies.every((value, index) => value === dependencies[index]) ? citationRefresh(previous, options.citations) : null;
      } })) return 'planned';
      complete(); return 'rendered';
    }
    function prepareCommit(previous, next) {
      const settled = settledPlans.get(next);
      if (settled && (settled.previous !== previous || !settledValid(previous, settled.settled) || !root.StreamingBody?.canPatch(previous, next)
        || !citationRefresh(previous, settled.citations))) {
        settledPlans.delete(next); settled.complete();
      }
      frontier?.prepare(previous,next,()=>!!root.StreamingBody?.canPatch(previous,next));
      const plan = plans.get(next); if (!plan) return;
      if (plan.previous !== previous || bodies.get(previous) !== plan.old || !validBody(previous, plan.old) || !sameDependencies(plan.old) || !citationRefresh(previous, plan.citations)) {
        plans.delete(next); plan.complete();
      }
    }
    function commitBody(previous, next, selection, patchTail) {
      if (settledPlans.has(next)) {
        prepareCommit(previous, next);
        const settled = settledPlans.get(next);
        if (settled) { settledPlans.delete(next); citationRefresh(previous, settled.citations)?.(); return true; }
      }
      if(frontier?.commit(previous,next,selection,patchTail)){adoptBody(previous,next);return true;}
      const plan = plans.get(next); if (!plan) return false;
      prepareCommit(previous, next);
      if (!plans.has(next)) return false;
      plans.delete(next);
      const old = plan.old, saved = Code.capture(old.code, selection);
      if (Code.apply(old.code, plan.change.edits, selection) === false) {
        Code.restore(old.code, selection, saved); plan.complete(); return false;
      }
      Code.restore(old.code, selection, saved);
      citationRefresh(previous, plan.citations)?.();
      const change = plan.change;
      bodies.set(previous, { ...old, continuation: change.state, commits: old.commits + 1,
        scannedCharacters: old.scannedCharacters + change.scannedCharacters,
        validatedCharacters: old.validatedCharacters + change.validatedCharacters,
        appendedCharacters: old.appendedCharacters + change.edits.reduce((sum, edit) => sum + (edit.append?.length || 0), 0) });
      return true;
    }
    function adoptBody(previous, next) {
      const settled = settledBodies.get(next);
      forgetSettled(previous);
      if (settled) { forgetSettled(next); rememberSettled(previous, settled); }
      frontier?.adopt(previous,next);
      const nextState = bodies.get(next);
      if (nextState) {
        const code = previous.lastElementChild?.lastElementChild;
        if (code?.nodeName === 'CODE') bodies.set(previous, { ...nextState, code });
        else bodies.delete(previous);
      } else bodies.delete(previous);
      bodies.delete(next);
    }
    function inspectBody(body) {
      const value = bodies.get(body);
      return value ? { active: true, sourceCharacters: value.continuation.raw.length, codeCharacters: value.continuation.codeLength,
        commits: value.commits, fullRenders: value.fullRenders, scannedCharacters: value.scannedCharacters,
        appendedCharacters: value.appendedCharacters, validatedCharacters: value.validatedCharacters } : { active: false };
    }
    return { render, renderBody, prepareCommit, commitBody, adoptBody, inspectBody, release, clear: () => {
      entries.clear(); frontier?.clear(); bodies = new WeakMap(); plans = new WeakMap(); tokens = new WeakMap(); settledPlans = new WeakMap();
      // New tokens invalidate every settled memo. Keep the weak body lookup
      // so the next adoption can disconnect its old observer; detached bodies
      // remain collectible without a registry that retains transcript content.
    },
      inspect: () => ({ entries: entries.size, characters: size(), maxEntries, maxCharacters }) };
  }
  return { ...create(), create };
});
