# Knowledge retrieval and source coverage

AI Bro distinguishes retrieved excerpts from originals included in a model request. A source link, an uploaded file, or a completed model response does not itself prove that every source was checked.

The current implementation provides:

- Project/space-scoped keyword retrieval over saved notes, paper records and indexed material text.
- Model-requested search and paged listing, followed by exact record reads or individual PDF page images. Search returns candidates; only successful reads appear in the on-demand read log.
- Explicit cursors for remaining records/text, so a response budget does not silently make the rest of the library inaccessible.
- Read activity, source IDs and PDF page numbers persisted with the run. Stop cancels ongoing work; repeated requests without progress produce an explicit failure.
- Separate, local draft adoption. Saved draft contents are never reconstructed from search excerpts. Approved text and earlier proposals retain history.

Synthetic acceptance covers a 125-record library, evidence at the end of that library, scope isolation, paged text reads, a model search/read round trip and draft acceptance without a model call. These tests do not measure real-model research quality or semantic recall.

This is currently keyword retrieval, **not a vector or hybrid semantic index**. Automatic batch reviews with persisted checkpoints and resumable cross-paper evidence tables are not implemented yet. Explicit full-original review still depends on the provider accepting the request size; a large corpus should use targeted search and page reads. Increasing a single context budget is not a substitute for batch coverage tracking.

中文：检索片段、上传原件、完成逐份核对是不同状态。当前已支持限定范围的关键词检索、分页访问和模型按需读取正文/PDF 页面，并保留读取记录。草稿采纳直接使用本地保存的完整内容。尚未实现向量/混合索引及可断点恢复的自动分批综述，不应将现有测试描述为上百篇论文全量审阅已经验收。
