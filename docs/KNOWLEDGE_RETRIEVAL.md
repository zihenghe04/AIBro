# Knowledge retrieval and source coverage

AI Bro uses local BM25 retrieval with optional hybrid semantic search: saved knowledge is split into source-linked passages, searched through a BM25 inverted index, and supplied to the model together with tools for further search and reading.

## Search and indexing

- The conversation path no longer uses the fixed 12,000-character initial excerpt budget. It returns complete matching chunks in pages of 20, with `nextOffset` for every remaining page. There is no two-chunk-per-record limit in this path.
- All active records in the permitted project/space participate. Chinese segmentation/bigrams and English word tokens support lexical search. Titles receive extra ranking weight. Structured paper sections honor human edits and retain existing source/page citations.
- The derived index is cached locally in memory. Record signatures reconcile changed text, moves, deletions and archived projects on each query; unchanged chunks reuse their postings. After restart it is rebuilt from the persisted workspace. BM25 remains available without credentials or additional extraction.
- Only saved text and metadata are indexed. A PDF without saved text has metadata coverage, not searchable full-text coverage. Its original remains available through page-image reads. A note summary about a PDF does not prove every PDF page is searchable or reviewed.
- The result panel distinguishes index scope, original-file count, text-indexed records, metadata-only records and returned passages. Subsequent model searches add their source references to the same response.

## Continued access

The model can request `list(query?, offset)`, `search(query, offset)`, `read(recordType, id, offset)` or `read_page(recordType: import, id, page)`. Catalogs and search pages carry explicit cursors. Search returns matching excerpts with stable chunk IDs, source IDs and available page numbers; only successful `read`/`read_page` operations appear in the on-demand read log. A 12,000-character **read page** is still a transport segment with a continuation cursor, not a limit on a document's total readable length.

Without embedding configuration, search queries are lexical. The model can reformulate them or list the catalog when matches are absent. A matching excerpt is evidence for its contents, not an assertion that the complete source was reviewed. A full-project check requires enumerating sources and tracking per-source coverage; top-ranked search results cannot establish complete coverage.

Saved draft decisions remain independent of retrieval. Adoption uses the complete locally saved proposal, and earlier text/proposals retain history.

## Validation and limits

Synthetic tests cover 150 searchable records, all 145 pages of a long indexed document, evidence on the last page, search pagination beyond the former character budget, edit/move/delete invalidation, scope isolation, source citations and metadata-only PDFs. An isolated Electron flow exercises a model search round trip and index reconstruction after reload, with model transport stubbed and external requests blocked. This does not measure real-model research quality or semantic recall.

Hybrid retrieval combines BM25 and cosine-ranked vectors using reciprocal rank fusion. It is not a learned reranker. Automatic batch reviews with persisted checkpoints and resumable cross-paper evidence tables remain unimplemented. Explicit full-original review still depends on the provider accepting the request size. Provider context limits remain; removing the old character cutoff does not make context unlimited.

中文：对话已改用本地 BM25 索引检索，去掉首轮 12,000 字符截断和每条资料最多两个片段的规则。索引覆盖全部范围内的已保存内容，返回结果可持续分页。没有正文索引的 PDF 会明确计入“仅文件信息”，可按需读取原件。可配置独立 embedding 服务启用混合检索；检索仍不等同于上百篇论文的自动全量审阅。

## Optional embedding configuration

Settings → Knowledge base semantic search accepts a separate OpenAI-compatible embedding endpoint, model, key and optional dimensions. ChatGPT/Codex subscription sign-in is not a general embedding API credential; API access and billing are separate. Local keyless services are supported explicitly. Connection tests send only synthetic test text.

The desktop key is independently encrypted through Electron safeStorage. The chat credential is never reused. Browser-only mode keeps the embedding key in session memory, not localStorage. Settings contain no key.

Use **Update vector index now** for manual updates, or enable **Automatically update changed content after saving**. Automatic work is debounced until workspace persistence succeeds and the Agent is idle. Only saved text and metadata participate; unadopted draft text is not substituted for the saved note. SHA-256 fingerprints avoid re-embedding unchanged passages. Completed batches survive interruption; edits/deletions during a request cannot introduce stale searchable evidence.

Vectors persist in local IndexedDB, separate from synced workspace data. Endpoint, model and dimensions identify separate indexes. Current-profile updates remove obsolete entries. Inactive profiles may remain locally cached, but search always filters against current source content and scope. Changing the browser origin/profile requires rebuilding this derived cache.

Queries combine keyword and semantic ranks, with continuation pages and stable citations. Missing keys or unavailable embedding services fall back to BM25 with an explicit status. No vector count means no semantic coverage. Embedding saved summaries does not embed the entire underlying PDF. Provider input/context limits still apply.

Core tests use deterministic synthetic embeddings to verify incrementality, restart reuse, scope isolation, stale-source rejection, cancellation and failed-batch recovery. They do not establish the quality or availability of a user's real embedding provider.
