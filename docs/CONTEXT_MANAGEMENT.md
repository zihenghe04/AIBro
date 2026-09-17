# AI Bro conversation context and retrieval

The full workspace and transcript remain durable data. A model request is a selected view of that data, not the database itself.

## Request lifecycle

1. Include the current request, explicitly attached/referenced material, a small library map (space/project/type counts), relevant recent messages and source-linked history checkpoints.
2. Expose a short capability catalogue and read tools. Do not eagerly search the knowledge base. A self-contained reminder or recurring event can use a compact, validated operation schema directly.
3. Let the model request searches, source reads, history lookups or operation schemas. Independent requests use the existing read-tool scheduler; dependent requests proceed in later rounds.
4. Search the existing embeddings and BM25 index, fuse ranks with RRF, and diversify repeated sources. Search pages are sized by an estimated token budget, not a global top-20 cutoff. Continue through `nextOffset`, change queries or read source text/pages. Library-wide audits use the complete paged catalogue rather than pretending ranked retrieval covers every document.
5. Retain recent evidence, a working summary and a bounded view of the read ledger in context. Keep the complete ledger on the run; `evidence_log` retrieves older entries. Evicted source bodies can be loaded again. Cached repeats do not execute tools again, while repeated requests making no progress still stop.
6. Validate the final plan with loaded operation schemas and existing application permissions, scope and source checks. No writes occur during retrieval. Calendar events remain reviewable proposals until saved in the native editor.

There is no default total search-result or productive tool-round ceiling. Per-request payload budgets, cancellation, scope checks and no-progress detection remain necessary. Increasing the library does not mean uploading it in full each turn.

## Long conversations

Small conversations incur no summarization request. Above the conservative estimated history budget, older text is compacted incrementally using the selected conversation model. The checkpoint stores exact quotations with message IDs and roles for goals, constraints, decisions, unresolved questions and context. Every quotation is checked against the source messages before saving. The original transcript is never replaced.

Recent messages, validated checkpoint excerpts and actual operation results are composed independently. A historical assistant statement is not proof of successful execution. `history_search`, `history_read` and `evidence_log` permit recovery of omitted content. Source edits invalidate derived checkpoints; cancelled or malformed summarization responses are not saved. A compaction failure retains original history and the main task can continue with explicit history lookup.

## Existing embeddings and practical bounds

Embedding profiles and chunk encoding are unchanged, so current vectors remain usable. Queries reuse a bounded query-vector cache; unchanged chunk hashes are reused. Documents changed or deleted during embedding are excluded from stale results. If the embedding service fails, BM25 fallback is reported explicitly.

This release uses local rank fusion and source diversification, not a newly added neural reranker or ANN database. Existing vector similarity search remains exact and linear over eligible vectors. Large-corpus ANN indexing and separately configured rerankers should be introduced only with retrieval evaluations and a migration plan. Token counts here are provider-neutral estimates, not provider billing measurements; native PDF/image input has separate delivery limits.

## References and adaptation

- [Pi agent loop](https://github.com/earendil-works/pi/blob/e4c75a73222ae2c72abb5f5314fa35ee8effc508/packages/agent/src/agent-loop.ts): model/tool loop and context transformation at the model boundary.
- [Pi compaction](https://github.com/earendil-works/pi/blob/e4c75a73222ae2c72abb5f5314fa35ee8effc508/packages/coding-agent/docs/compaction.md): preserve complete session records, derive compact context, track source operations and reserve room for generation.
- [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents): just-in-time retrieval and managing finite context.
- [Anthropic contextual retrieval](https://www.anthropic.com/engineering/contextual-retrieval): semantic and lexical retrieval complement each other; retrieval and selected model context are different stages.

These are architectural references. AI Bro retains its own persistence, operation validation and native calendar integration; it does not import or claim to reproduce Pi's runtime. It also does not regenerate contextual embeddings or add an unconfigured external reranker.

## Validation

Tests cover no-search conversation, library metadata without source bodies, mixed search/reminder workflows, on-demand schema validation, old-message paging and scope isolation, exact checkpoint quotations and invalidation, 180-source hybrid pagination, more than 64 productive read rounds, source changes during embedding, cancellation, and repeated-tool detection. Native QA uses a separate synthetic workspace and stubbed model responses to exercise the real send/save and recurring-event review paths. These tests do not measure live provider latency or real-model retrieval accuracy.
