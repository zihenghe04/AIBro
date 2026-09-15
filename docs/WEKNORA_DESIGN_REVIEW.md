# WeKnora 设计分析与 AI Bro 取舍

分析日期：2026-09-15。实际浅克隆 `Tencent/WeKnora` 的 `1ef38fdb8b19347b82d3a99f6f17d75ac09ad606`，只读分析源码；没有运行第三方服务、安装其依赖或上传本机资料。以下是针对个人科研工作区的设计取舍，不是整套产品移植。参考仓库的主许可为 MIT，另有第三方组件许可清单；本轮独立实现交互和算法，不复制上游源文件。

## 值得借鉴的实际实现

1. **检索是可观察的流水线**。`internal/application/service/chat_pipeline/query_understand.go` 先保留原问题，再按配置结合历史改写；`rerank.go` 对候选正文重排，服务失败回退；`merge.go` 去重、回填父块、合并连续片段、扩展相邻内容。启发：把“找到哪些、没找到哪些、是否还有下一页”展示出来，不能用检索命中数冒充已审阅原件数。
2. **切块保留结构与位置**。`internal/infrastructure/chunker/heading_splitter.go` 用章节边界，并将标题路径与原文区间分开保存。启发：科研长文命中实验结果时同时交代所在章节，保留原文 offset，允许进一步打开前后片段；避免盲目把全库填进提示词。
3. **Wiki 是需要维护的产物**。`wiki_lint.go` 检查断链、失效来源、空页和孤立页；`WikiBrowser.vue` 将目录、正文、关系图及修订放在同一知识库界面。AI Bro 采用明确的问题列表和真实来源关系，不给主观知识质量打“健康分”，也不因来源失效自动删除用户笔记。
4. **持续整理有队列与状态**。`wiki_ingest_batch.go` 分批领取任务、按需读取已有页面、处理限流后的延迟重试；`wiki_ingest_dedup.go` 在模型去重前筛选合理候选。AI Bro 需要能看到待分析、执行中、待审阅、失败的来源处理状态，并可继续处理；不要每次增加论文都重建全库，也不要把两篇看似相近的论文自动合并。
5. **图用于定位，不代替证据**。Wiki 图提供搜索、筛选与局部展开。AI Bro 先画批准正文中真实存在的链接和显式来源；语义相似和 AI 猜测关系必须另行标识，不使用装饰性随机连线。

## 本轮纳入路线图

| 优先级 | 实施项 | 验收要求 |
|---|---|---|
| P0 | 阅读区可见性及后台服务生命周期 | 隐藏 WebView 打开阅读区仍有实际宽度；App 退出后所属后台退出 |
| P0 | 科研 Wiki 检查与来源处理入口 | 断链、失效来源、正文读取错误、待审阅/待分析可定位；检查不改正文、不删除资料 |
| P1 | 检索试验面板 | 复用实际 BM25/可选混合检索；显示范围、正文索引、候选、分页、来源和页码；明确不等于全文审阅 |
| P1 | 章节路径与相邻证据 | 片段保留原 offset；章节名参与召回；相邻片段只能来自同一授权来源，版本变化拒绝旧片段 |
| P2 | 来源关系浏览与分批整理 | 真实边可导航；待分析来源可选择后交给现有 Agent；已有笔记更新沿用 Diff 草稿，不覆盖批准正文 |

各项状态以 `WORKFLOW_EVOLUTION.md` 最新验收表为准。这里的优先级是产品实施顺序，不是已经完成的声明。

## 暂缓而非伪装完成

- 企业 RBAC、多租户、分布式队列、Redis/向量服务集群、Docker/E2B 沙箱、第三方云同步连接器：个人本机产品暂不承担部署复杂度。
- 默认每问必调用额外改写/重排模型：已有 Agent 可主动多轮改写检索，先完成检索可视化和可测的证据邻域，再用实测收益决定是否增加独立模型配置及费用。
- 自动批量改写或删除 Wiki、无人审批合并近似概念：用户研究结论不能被后台静默重写，先采用来源批次与审阅草稿。
- 全局大型力导向图、推断关系自动写入：先提供聚焦当前条目的真实关系视图，避免百篇论文造成视觉噪声与卡顿。
- SQLite 只读查询、音视频解析继续按用户原要求暂缓。自动任务关闭 App 后运行仍暂缓，不声称有系统常驻守护服务。

## 固定版本来源

- [检索合并流水线](https://github.com/Tencent/WeKnora/blob/1ef38fdb8b19347b82d3a99f6f17d75ac09ad606/internal/application/service/chat_pipeline/merge.go)
- [章节切块](https://github.com/Tencent/WeKnora/blob/1ef38fdb8b19347b82d3a99f6f17d75ac09ad606/internal/infrastructure/chunker/heading_splitter.go)
- [Wiki 检查](https://github.com/Tencent/WeKnora/blob/1ef38fdb8b19347b82d3a99f6f17d75ac09ad606/internal/application/service/wiki_lint.go)
- [分批整理](https://github.com/Tencent/WeKnora/blob/1ef38fdb8b19347b82d3a99f6f17d75ac09ad606/internal/application/service/wiki_ingest_batch.go)
- [Wiki 交互](https://github.com/Tencent/WeKnora/blob/1ef38fdb8b19347b82d3a99f6f17d75ac09ad606/frontend/src/views/knowledge/wiki/WikiBrowser.vue)
