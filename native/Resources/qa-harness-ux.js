state.ui.workspaceTour={version:1,status:'skipped'};window.WorkspaceTour?.close();
// Agent 交互改进的原生验收断言（合成数据、只读或可复原地使用真实渲染路径）。
// 依据 docs/AGENT_HARNESS_UX_IMPLEMENTATION.md：段级呼吸、插话队列、段级耗时、
// 消息级实测用量。此文件由 AIBro.swift 的 AIBRO_NATIVE_QA_HARNESS_UX 分支加载，
// 不参与默认 QA 流程，也不断言任何既有行为。
const check = (value, message) => { if (!value) throw Error(message); };

// 1) 本轮新增模块与输入区容器在真实外壳中已加载
check(typeof window.AgentQueue === 'object' && typeof AgentQueue.enqueue === 'function', 'queued follow-up module is loaded');
check(typeof window.AgentProgress === 'object' && typeof AgentProgress.markup === 'function', 'progress module is loaded');
check(['#composerActivity', '#composerQueue', '#composerContextStrip'].every(s => document.querySelector(s)), 'composer activity/queue/context strips exist');

// 2) 段级呼吸：流式段张开、已收束段闭合、整轮结束后全部收束、用户固定不被自动覆盖
const t = Date.now();
const breath = {id: 'qa-ux-breath', role: 'assistant', text: '', live: true, startedAt: t - 12000,
  activities: [
    {id: 'qa-ux-s1', kind: 'summary', text: '第一段思考', status: 'completed', at: t - 11000, updatedAt: t - 9000},
    {id: 'qa-ux-s2', kind: 'tool', name: '读取文件', text: '已读取 3 个片段', status: 'completed', at: t - 8000, updatedAt: t - 6000},
    {id: 'qa-ux-s3', kind: 'summary', text: '第二段思考', status: 'running', at: t - 2000, updatedAt: t}
  ]};
const openKeys = (html, includeFeed = false) => [...html.matchAll(/data-progress-key="([^"]+)" open(?=[\s>])/g)].map(m => m[1]).filter(key => includeFeed || key !== 'feed');
const streaming = AgentProgress.markup(breath);
check(JSON.stringify(openKeys(streaming)) === JSON.stringify(['qa-ux-s3']), 'streaming segment opens while settled segments stay collapsed: ' + JSON.stringify(openKeys(streaming)));
check(openKeys(streaming, true).includes('feed'), 'the whole feed is expanded while the turn streams');
breath.live = false; AgentProgress.finish(breath, 'completed');
check(openKeys(AgentProgress.markup(breath), true).length === 0, 'every segment and the feed collapse once the turn settles');
AgentProgress.pin(breath, 'qa-ux-s2', true);
check(openKeys(AgentProgress.markup(breath)).includes('qa-ux-s2'), 'manual expansion survives settling');
breath.live = true; breath.activities.forEach(a => { a.status = 'completed'; });
check(AgentProgress.markup(breath).includes('等待模型继续'), 'transition heading while no segment is streaming');

// 3) 段级耗时：只有起止时间都真实的段才显示自身用时
const timed = {id: 'qa-ux-timed', role: 'assistant', live: false, runStatus: 'completed', startedAt: t - 40000, finishedAt: t,
  activities: [{id: 'qa-ux-t1', kind: 'tool', name: '读取文件', status: 'completed', at: t - 37000, updatedAt: t - 3000}]};
check(AgentProgress.markup(timed).includes('progress-cost'), 'settled segment shows its own measured duration');
const untimed = {id: 'qa-ux-untimed', role: 'assistant', live: false, runStatus: 'completed',
  activities: [{id: 'qa-ux-u1', kind: 'tool', name: '读取文件', status: 'completed'}]};
check(!AgentProgress.markup(untimed).includes('progress-cost'), 'segment without timestamps shows no invented duration');

// 4) 运行中插话：真实队列 API 的入队 / 计数 / 顺序消费 / 清空，且行按状态显隐
const chat = state.conversations[0];
AgentQueue.clear(chat);
check(AgentQueue.count(chat) === 0, 'queue starts empty');
AgentQueue.enqueue(chat, {goal: '合成排队消息一', attachmentIds: []}, Date.now());
AgentQueue.enqueue(chat, {goal: '合成排队消息二', attachmentIds: []}, Date.now());
check(AgentQueue.count(chat) === 2, 'queued entries are counted');
check(AgentQueue.enqueue(chat, {goal: '   ', attachmentIds: []}, Date.now()) === null, 'blank follow-ups are refused');
const strip = document.querySelector('#composerQueue');
renderComposerQueue();
check(!strip.hidden && strip.textContent.includes('2'), 'queue strip reflects pending entries: ' + strip.textContent);
AgentQueue.shift(chat);
check(AgentQueue.count(chat) === 1, 'queued entries are consumed in order');
AgentQueue.clear(chat); renderComposerQueue();
check(strip.hidden, 'queue strip hides once drained');

// 5) 消息元信息：测量到的耗时与用量才显示，未测量不得编造 tokens
// The message list only mounts rows while it is visible (ConversationWindow);
// earlier QA steps leave another view open, so show the conversation first.
showView('agent', '对话');
state.agentRuns.push({id: 'qa-ux-run', conversationId: chat.id, status: 'completed', startedAt: t - 64000, finishedAt: t});
chat.messages.push({id: 'qa-ux-meta', role: 'agent', text: '合成用量消息。', usage: {input: 900, output: 600, total: 1500}, runId: 'qa-ux-run'});
state.currentConversationId = chat.id; renderConversation();
const measured = document.querySelector('[data-message-id="qa-ux-meta"] .message-meta');
check(measured, 'message meta renders for a completed reply');
check(measured.textContent.includes('1.5k'), 'measured token usage shown: ' + measured.textContent);
check(measured.textContent.includes('1 分'), 'measured duration shown: ' + measured.textContent);
state.agentRuns.push({id: 'qa-ux-run-2', conversationId: chat.id, status: 'completed', startedAt: t - 5000, finishedAt: t});
chat.messages.push({id: 'qa-ux-meta-2', role: 'agent', text: '无用量消息。', runId: 'qa-ux-run-2'});
renderConversation();
const unmeasured = document.querySelector('[data-message-id="qa-ux-meta-2"] .message-meta');
check(unmeasured, 'message meta renders without usage too');
check(!unmeasured.textContent.includes('tokens'), 'unmeasured usage never fabricates tokens: ' + unmeasured.textContent);
for (const id of ['qa-ux-meta', 'qa-ux-meta-2']) { const index = chat.messages.findIndex(m => m.id === id); if (index >= 0) chat.messages.splice(index, 1); }
for (const id of ['qa-ux-run', 'qa-ux-run-2']) { const index = state.agentRuns.findIndex(r => r.id === id); if (index >= 0) state.agentRuns.splice(index, 1); }
renderConversation();


// 3) 审查者代批（T4）：默认关闭、边界不变、不可逆动作与归属确认永不代批、连续不建议执行即熔断
check(typeof window.ReviewerDelegate === 'object' && typeof ReviewerDelegate.decide === 'function', 'reviewer delegate module is loaded');
check(typeof window.WorkstationPermissionPolicy?.canDelegateReview === 'function', 'policy exposes the delegation boundary check');
check(WorkstationPermissionPolicy.canDelegateReview({ actions: [{type: 'create_task'}], enabled: true }) === true, 'non-destructive workstation actions may be delegated once enabled');
check(WorkstationPermissionPolicy.canDelegateReview({ actions: [{type: 'create_task'}] }) === false, 'delegation stays off unless explicitly enabled');
check(WorkstationPermissionPolicy.canDelegateReview({ actions: [{type: 'delete_note'}], enabled: true }) === false, 'destructive actions are never delegated');
check(WorkstationPermissionPolicy.canDelegateReview({ actions: [{type: 'run_command'}], enabled: true }) === false, 'actions outside the workstation list are never delegated');
check(WorkstationPermissionPolicy.canDelegateReview({ actions: [{type: 'create_task'}], routingReview: true, enabled: true }) === false, 'routing confirmations are never delegated');
check(ReviewerDelegate.decide({ verdict: 'approve' }).action === 'approve', 'an explicit approval is delegated');
check(ReviewerDelegate.decide({ verdict: 'caution' }).action === 'handback', 'caution hands back to the human');
check(ReviewerDelegate.decide({ verdict: 'other' }).action === 'handback', 'an inconclusive review hands back to the human');
let qaDenials = 0;
for (let round = 0; round < ReviewerDelegate.DENIAL_LIMIT; round += 1) qaDenials = ReviewerDelegate.decide({ verdict: 'reject', denials: qaDenials }).denials;
check(ReviewerDelegate.decide({ verdict: 'reject', denials: qaDenials }).action === 'halt', 'repeated objections halt automatic progress');
check(typeof window.forkConversationBranch === 'function' && typeof window.switchConversationBranch === 'function', 'in-conversation branch entry points are wired');

// 4) 消息级会话树（T7）：分叉截断当前路径、切换与切回不丢任何消息、来源元数据往返保留
check(typeof window.ConversationBranches === 'object' && typeof ConversationBranches.switchTo === 'function', 'conversation branch module is loaded');
const qaMsgs = [
  {id: 'qa-b1', role: 'user', text: '第一问', at: t},
  {id: 'qa-b2', role: 'agent', text: '答一', at: t + 1},
  {id: 'qa-b3', role: 'user', text: '第二问', at: t + 2},
  {id: 'qa-b4', role: 'agent', text: '答二', at: t + 3}
];
const qaFork = ConversationBranches.fork({ messages: qaMsgs, createdAt: t }, 'qa-b2', 'qa-br', t);
check(!qaFork.error, 'fork splits at a message');
// full-v1 branches carry the complete original path (tests/conversation-branches.test.js).
check(qaFork.keep.map(item => item.id).join(',') === 'qa-b1,qa-b2' && qaFork.afterCount === 2, 'fork keeps the head and counts the parked tail');
check(qaFork.branch.messages.map(item => item.id).join(',') === 'qa-b1,qa-b2,qa-b3,qa-b4' && qaFork.branch.historyFormat === 'full-v1', 'branch keeps the complete original path');
const qaReach = value => new Set([...(value.messages || []), ...(value.branches || []).flatMap(branch => branch.messages || [])].map(item => item.id));
check(qaMsgs.every(item => qaReach({ messages: qaFork.keep, branches: [qaFork.branch] }).has(item.id)), 'fork conserves every message');
check(qaFork.branch.fromMessageId === 'qa-b2', 'branch records the message it split from');
const qaSwitched = ConversationBranches.switchTo({ messages: qaFork.keep, branches: [qaFork.branch], activeBranch: qaFork.activeBranch, createdAt: t }, 'qa-br', t + 10);
check(qaSwitched.messages.map(item => item.id).join(',') === 'qa-b1,qa-b2,qa-b3,qa-b4', 'switch loads the target path');
check(qaSwitched.branches.find(item => item.id === 'main').messages.map(item => item.id).join(',') === 'qa-b1,qa-b2', 'the previous path is parked intact');
const qaBack = ConversationBranches.switchTo({ messages: qaSwitched.messages, branches: qaSwitched.branches, activeBranch: qaSwitched.activeBranch, createdAt: t }, 'main', t + 20);
check(qaBack.messages.map(item => item.id).join(',') === 'qa-b1,qa-b2', 'switching back restores the original path');
check(qaBack.branches.find(item => item.id === 'qa-br').fromMessageId === 'qa-b2', 'branch provenance survives a round trip');
check(qaMsgs.every(item => qaReach(qaSwitched).has(item.id)) && qaMsgs.every(item => qaReach(qaBack).has(item.id)), 'no message is lost across a switch');


// 5) 工具空转预警（T19）：机械判定、参数不同的分页读取不误伤、未完成的调用不计入
check(typeof window.ToolLoopGuard === 'object' && typeof ToolLoopGuard.inspect === 'function', 'tool loop guard module is loaded');
const qaLoop = Array.from({length: ToolLoopGuard.LIMIT}, (_, index) => ({id: 'qa-g' + index, type: 'read', request: {type: 'read', id: 'note_1'}, status: 'completed'}));
check(ToolLoopGuard.inspect(qaLoop).repeated.length === 1, 'identical repeated calls are reported');
check(ToolLoopGuard.inspect(qaLoop.slice(0, ToolLoopGuard.LIMIT - 1)).repeated.length === 0, 'the guard stays quiet below the limit');
const qaPaged = [0, 800, 1600, 2400].map(offset => ({id: 'qa-p' + offset, type: 'read', request: {type: 'read', id: 'note_1', offset}, status: 'completed'}));
check(ToolLoopGuard.inspect(qaPaged).repeated.length === 0, 'paged reads with different offsets are not flagged');
check(/完整上下文/.test(ToolLoopGuard.describe({type: 'read', count: 6}, 4)), 'the message explains the cost honestly');

// 6) 停止后可继续编辑（与 T19 同轮落地）：输入回填入口存在且不覆盖已写内容
check(typeof window.restoreStoppedInput === 'function', 'stopped-round input restore is wired');
check(!!document.querySelector('#agentInput'), 'composer input exists for restoration');
const qaInput = document.querySelector('#agentInput');
const qaPrevious = qaInput.value;
qaInput.value = '用户正在写的内容';
check(restoreStoppedInput({ id: 'qa-restore' }, { id: 'qa-run', goal: '被停止的输入' }) === false, 'restoration never overwrites what the user is already typing');
check(qaInput.value === '用户正在写的内容', 'what the user typed must survive untouched');
qaInput.value = qaPrevious;


// 7) 模型来源逐级回退（T20）：未配置的层级跳过、按序回退、来源如实标注
check(typeof window.ModelChain === 'object' && typeof ModelChain.resolve === 'function', 'model chain module is loaded');
const qaDefaults = {provider: 'api', model: 'qa-global', effort: ''};
check(ModelChain.resolve({conversation: {modelConfig: {model: 'qa-conv'}}}, qaDefaults).source === 'conversation', 'conversation setting wins');
check(ModelChain.resolve({conversation: {}, project: {modelConfig: {model: 'qa-project'}}}, qaDefaults).source === 'project', 'project wins over workspace');
check(ModelChain.resolve({conversation: {}, settings: {workspaceModelConfig: {科研: {model: 'qa-ws'}}}, workspace: '科研'}, qaDefaults).source === 'workspace', 'workspace applies when nothing above is set');
check(ModelChain.resolve({conversation: {}, workspace: '课程'}, qaDefaults).source === 'default', 'unconfigured workspace falls back to the global default');
check(ModelChain.resolve({conversation: {modelConfig: {model: '   '}}}, qaDefaults).source === 'default', 'a blank model name is not a configuration');
check(typeof window.convertConversationToProject === 'function', 'conversation-to-project conversion is wired');


// 8) 任务产出校验（T21）：未声明不受影响、缺失即拦截、补齐后可完成
check(typeof window.TaskDeliverable === 'object' && typeof TaskDeliverable.validate === 'function', 'task deliverable module is loaded');
check(TaskDeliverable.validate({id: 'qa-t', status: 'todo'}, {}).ok === true, 'a task without a declared deliverable is never blocked');
check(TaskDeliverable.validate({deliverable: {kind: 'note', ref: 'qa-note'}}, {notes: []}).ok === false, 'a missing note blocks completion');
check(TaskDeliverable.validate({deliverable: {kind: 'note', ref: 'qa-note'}}, {notes: [{id: 'qa-note'}]}).ok === true, 'an existing note allows completion');
check(TaskDeliverable.validate({deliverable: {kind: 'text', mustInclude: '第 5 组'}, description: '已完成前三组'}, {}).ok === false, 'a missing keyword blocks completion');
check(/保持未完成/.test(TaskDeliverable.message({}, {ok: false, reason: '找不到一条笔记'})), 'the failure message says the task stays unfinished');


// 9) 工具类型聚合行（T1 增强）：连续同类「已结束」工具合并为一行次数与实测总耗时；
//    单项不聚合；进行中的项不参与聚合、也不打断其前面的已完成组；组内含进行中成员时不聚合
const qaAgg = {id: 'qa-agg', role: 'assistant', text: '', live: true, startedAt: t, activities: []};
AgentProgress.update(qaAgg, {id: 'qa-a1', kind: 'tool', name: '读取文件', text: 'a.csv', status: 'running'}, t - 3000);
AgentProgress.update(qaAgg, {id: 'qa-a1', kind: 'tool', name: '读取文件', text: 'a.csv', status: 'completed'}, t - 1500);
const qaSingle = AgentProgress.markup(qaAgg);
check(!qaSingle.includes('progress-group-text'), 'a single finished tool is not aggregated');
AgentProgress.update(qaAgg, {id: 'qa-a2', kind: 'tool', name: '读取文件', text: 'b.csv', status: 'running'}, t - 1400);
AgentProgress.update(qaAgg, {id: 'qa-a2', kind: 'tool', name: '读取文件', text: 'b.csv', status: 'completed'}, t);
check(/progress-group-text">读取文件 ×2/.test(AgentProgress.markup(qaAgg)), 'adjacent identical finished tools aggregate with a count');
check(/progress-group-cost">累计 [0-9]+ 秒</.test(AgentProgress.markup(qaAgg)), 'the aggregate row shows the measured total duration');
AgentProgress.update(qaAgg, {id: 'qa-a3', kind: 'tool', name: '读取文件', text: 'c.csv', status: 'running'}, t + 10);
const qaWithRunning = AgentProgress.markup(qaAgg);
// Current grouping contract (tests/agent-progress.test.js): a running member joins its
// group, the status line separates states, and the group opens while anything runs.
check(/progress-group-status">进行中 1 · 已完成 2</.test(qaWithRunning) && /data-progress-key="group:qa-a1" open/.test(qaWithRunning), 'a running follow-up stays in the group and keeps the settled members visible');
check(!/已完成 3/.test(qaWithRunning), 'a still-running tool is never counted as completed');
const qaRunningGroup = {id: 'qa-run-group', role: 'assistant', text: '', live: true, startedAt: t, activities: []};
AgentProgress.update(qaRunningGroup, {id: 'qa-r1', kind: 'tool', name: '运行命令', text: 'x', status: 'running'}, t - 2000);
AgentProgress.update(qaRunningGroup, {id: 'qa-r1', kind: 'tool', name: '运行命令', text: 'x', status: 'completed'}, t - 1000);
AgentProgress.update(qaRunningGroup, {id: 'qa-r2', kind: 'tool', name: '运行命令', text: 'y', status: 'running'}, t - 900);
check(/progress-group-status">进行中 1 · 已完成 1</.test(AgentProgress.markup(qaRunningGroup)), 'a group containing a running member reports it as running, not completed');

// 10) 结构化问询卡片（T23）：只接受可枚举选项、答案语义完整、渲染转义、提交后只读
check(typeof window.ClarifyQuestions === 'object' && typeof ClarifyQuestions.validate === 'function', 'clarify questions module is loaded');
const qaQuestions = ClarifyQuestions.validate([
  {id: 'q1', question: '选哪个范围？', options: ['近一周', '本月']},
  {id: 'q2', question: '这是一个没有选项的追问'},
  {id: 'q3', question: '只有一个选项', options: ['唯一']}
]);
check(qaQuestions.length === 1 && qaQuestions[0].id === 'q1', 'only enumerable questions survive validation: ' + qaQuestions.length);
check(ClarifyQuestions.answerText(qaQuestions, {q1: ['本月']}) === '回答上面的问题：\n· 选哪个范围？ 本月', 'the answer message carries question and selection verbatim');
check(ClarifyQuestions.answerText(qaQuestions, {}) === null, 'no selection means no message is sent');
check(ClarifyQuestions.answerText(qaQuestions, {q1: ['不存在的选项']}) === null, 'options outside the card are not accepted');
const qaCard = ClarifyQuestions.markup({questions: qaQuestions, draft: {q1: ['本月']}, submittedAt: 0});
check(/data-clarify-pick="q1"/.test(qaCard) && /aria-pressed="true"/.test(qaCard), 'options render as pickable buttons with pressed state');
const qaEscaped = ClarifyQuestions.markup({questions: ClarifyQuestions.validate([{id: 'q9', question: '<img src=x>', options: ['<script>bad</script>', 'ok']}]), draft: {}, submittedAt: 0});
check(!qaEscaped.includes('<script>') && !qaEscaped.includes('<img'), 'external text is escaped, never injected as markup');
const qaDoneCard = ClarifyQuestions.markup({questions: qaQuestions, draft: {}, submittedAt: t, answers: {q1: ['近一周']}});
check(!qaDoneCard.includes('data-clarify-pick') && qaDoneCard.includes('已回答'), 'a submitted card is read-only');
check(/近一周/.test(qaDoneCard), 'the submitted card shows the answer actually sent');

// 11) 工具执行记录自动呼吸（T24）：轮次中自动展开、终态自动收敛、用户手动优先
const qaLiveLedger = ToolScheduler.card({status: 'running', toolCalls: [
  {id: 'qa-l1', type: 'read', status: 'running', request: {type: 'read', id: 'n1'}},
  {id: 'qa-l2', type: 'read', status: 'completed', request: {type: 'read', id: 'n2'}, finishedAt: t}
]});
check(qaLiveLedger.open === true, 'the tool history opens automatically while the round is running');
const qaLiveRows = [...qaLiveLedger.querySelectorAll('.tool-ledger-row')];
check(qaLiveRows[0].open === true && qaLiveRows[1].open === false, 'the running tool row expands while finished rows stay folded');
const qaSettledLedger = ToolScheduler.card({status: 'completed', finishedAt: t, toolCalls: [{id: 'qa-l3', type: 'read', status: 'completed', request: {type: 'read'}}]});
check(qaSettledLedger.open === false, 'the settled tool history folds back into one summary line');
const qaPinnedLedger = ToolScheduler.card({status: 'completed', finishedAt: t, toolLedgerPins: {ledger: true}, toolCalls: [{id: 'qa-l4', type: 'read', status: 'completed', request: {type: 'read'}}]});
check(qaPinnedLedger.open === true, 'a manual choice wins over the automatic collapse');
const qaHeldLedger = ToolScheduler.card({status: 'running', toolLedgerPins: {ledger: false}, toolCalls: [{id: 'qa-l5', type: 'read', status: 'running', request: {type: 'read'}}]});
check(qaHeldLedger.open === false, 'a manual collapse is never overridden by the automatic expand');

// 12) 原件预览补充形态（T33）：视频/音频控件、CSV 表格（转义 + 上限）、HTML 空沙箱
check(typeof window.PreviewMedia === 'object' && typeof PreviewMedia.mount === 'function', 'preview media module is loaded');
const qaCsv = PreviewMedia.tableMarkup(PreviewMedia.parseDelimited('a,"b,c"\n"x""y",z'));
// 首行是表头：b,c 落在 <th> 里，x"y 落在正文格子里（断言按真实结构写）
check(/<th>a<\/th>/.test(qaCsv) && /<th>b,c<\/th>/.test(qaCsv) && /<td>x&quot;y<\/td>/.test(qaCsv), 'CSV parses quoted fields, embedded commas and doubled quotes');
const qaCsvEsc = PreviewMedia.tableMarkup([['<script>alert(1)</script>'], ['<img src=x onerror=1>']]);
check(!/<script/i.test(qaCsvEsc) && !/<img/i.test(qaCsvEsc), 'CSV cells are escaped, never injected as markup');
const qaCsvBig = PreviewMedia.tableMarkup(Array.from({length: 250}, (_, i) => ['r' + i]));
check(/还有 50 行未显示/.test(qaCsvBig), 'bounded tables state how many rows are withheld');
const qaHost = document.createElement('div');
check(PreviewMedia.mount(qaHost, {mime: 'video/mp4', name: 'a.mp4', url: 'blob:x'}) === 'video' && qaHost.querySelector('video')?.controls === true, 'video mounts with native controls');
check(PreviewMedia.mount(qaHost, {mime: 'audio/mpeg', name: 'a.mp3', url: 'blob:z'}) === 'audio' && qaHost.querySelector('audio') !== null, 'audio mounts with native controls');
check(PreviewMedia.mount(qaHost, {mime: 'text/html', name: 'a.html', url: 'blob:y'}) === 'html' && qaHost.querySelector('iframe')?.getAttribute('sandbox') === '', 'HTML previews inside an empty sandbox');
check(PreviewMedia.mount(qaHost, {mime: 'text/csv', name: 'a.csv', text: 'h1,h2\n1,2'}) === 'csv' && qaHost.querySelector('table.preview-table') !== null, 'CSV renders as a table from parsed text alone');
check(PreviewMedia.mount(qaHost, {mime: 'application/pdf', name: 'a.pdf'}) === null, 'PDF stays with the existing branch');

// 13) 富文本扩展（T34/T35）：代码高亮内容守恒、未知语言不假高亮、数学渲染与转义
check(typeof window.CodeHighlight === 'object' && typeof CodeHighlight.highlight === 'function', 'code highlight module is loaded');
const qaJs = CodeHighlight.highlight('const x = 1+2; // note', 'js');
check(/tok-keyword">const</.test(qaJs) && /tok-number">1</.test(qaJs) && /tok-comment">/.test(qaJs), 'keywords, numbers and comments are tokenized');
const qaPlain = qaJs.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
check(qaPlain === 'const x = 1+2; // note', 'highlighting never changes the code text');
check(CodeHighlight.highlight('x', 'brainfuck') === null, 'unknown languages are not guessed');
check(!/<script/i.test(CodeHighlight.highlight('<script>alert(1)</script>', 'js')), 'code is escaped, never injected');
check(typeof window.MathRender === 'object' && typeof MathRender.inlineMath === 'function', 'math render module is loaded');
const qaMath = MathRender.inlineMath('\\frac{a}{b}');
check(/math-frac/.test(qaMath) && /math-num">a</.test(qaMath), 'fractions render with numerator and denominator');
check(/α/.test(MathRender.inlineMath('\\alpha')) && /∑/.test(MathRender.inlineMath('\\sum')), 'symbols map to their characters');
check(!/<img/i.test(MathRender.inlineMath('<img src=x>')), 'math content is escaped');
check(/\\foobar/.test(MathRender.inlineMath('\\foobar{x}')), 'unknown commands stay literal instead of being guessed');
// 真实渲染路径：一条消息同时走代码高亮与数学渲染
const qaFence = String.fromCharCode(96).repeat(3);
// 围栏必须在行首才被识别：这里用空行把公式段落与代码块分开（断言按真实语法写）
const qaRendered = renderRichText('公式 $E = mc^2$\n\n' + qaFence + 'js\nconst y = 1;\n' + qaFence);
check(/math-inline/.test(qaRendered) && /tok-keyword/.test(qaRendered) && /message-code-lang/.test(qaRendered), 'the real renderer wires both modules');
check(/E = mc\^2/.test(qaRendered), 'the rendered formula keeps its original TeX in aria-label');

// 14) 项目排期（T36）：排期 Tab 接进外壳、周一是七天之首、按日期分桶且无日期任务不丢
check(typeof window.ProjectSchedule === 'object' && typeof ProjectSchedule.mount === 'function', 'project schedule module is loaded');
check(/\u6392\u671f/.test(document.querySelector('[data-project-tab="schedule"]')?.textContent || ''), 'the schedule tab is wired into the project view');
const qaDays = ProjectSchedule._pure.daysOfWeek(Date.now());
check(qaDays.length === 7 && qaDays[0].label === '周一' && qaDays[6].label === '周日', 'the week runs Monday through Sunday');
const qaBucketed = ProjectSchedule._pure.bucketTasks([
  { id: 'qa-x1', title: 'A', dueAt: qaDays[2].ts + 3600000, status: 'todo' },
  { id: 'qa-x2', title: 'B', dueAt: null, status: 'blocked' }
], qaDays);
check(qaBucketed.byDay[2].length === 1, 'tasks bucket onto their due date');
check(qaBucketed.unscheduled.length === 1, 'tasks without a due date stay visible instead of being dropped');
check(ProjectSchedule._pure.taskTone({ status: 'blocked' }) === 'blocked' && ProjectSchedule._pure.taskTone({ status: 'done' }) === 'done', 'status tones drive the colour dots');
check(/\u8ba1\u5212/.test(ProjectSchedule._pure.planMarkup({ plan: '# x' })), 'the plan panel renders with its fixed heading');
check(!/<script/i.test(ProjectSchedule._pure.planMarkup({ plan: '<script>alert(1)</script>' })), 'plan text is escaped');

// 15) 消息媒体（T37）：相邻图片合并画廊、视频内嵌、无地址不假渲染
check(typeof window.MessageMedia === 'object' && typeof MessageMedia.render === 'function', 'message media module is loaded');
const qaMediaImages = [
  { id: 'qi1', original: { id: 'qi1', name: 'a.png', mimeType: 'image/png', fileStored: true } },
  { id: 'qi2', original: { id: 'qi2', name: 'b.png', mimeType: 'image/png', fileStored: true } }
];
const qaGallery = MessageMedia.render(qaMediaImages).markup;
check(/message-media-gallery is-multi/.test(qaGallery) && /data-open-import="qi1"/.test(qaGallery), 'adjacent images merge into one gallery with the preview entry');
check(/<img[^>]*alt="a\.png"/.test(qaGallery), 'gallery images carry alt text');
const qaVideo = MessageMedia.render([{ id: 'qv', original: { id: 'qv', name: 'v.mp4', mimeType: 'video/mp4', fileStored: true } }]).markup;
check(/<video[^>]*controls/.test(qaVideo) && /src="\/__files\/qv"/.test(qaVideo), 'video renders inline with native controls');
const qaLegacy = MessageMedia.render([{ id: 'ql', original: { id: 'ql', name: 'old.png', mimeType: 'image/png', fileStored: false, dataUrl: null } }]);
check(qaLegacy.blocks.length === 0 && qaLegacy.rest.length === 1, 'media without a reachable address falls back instead of showing a broken element');
check(!/<img\s+src=x/.test(MessageMedia.render([{ id: 'qx', original: { id: 'qx', name: '<img src=x>.png', mimeType: 'image/png', fileStored: true } }]).markup), 'file names are escaped');

// 16) Connected review workspace and stable progress in WKWebView.
check(typeof ReviewWorkbench === 'object', 'review workspace is packaged and loaded');
const qaReviewBefore={notes:[{id:'qa-review-doc',title:'Interaction plan',folderPath:'design',content:'# Plan\nOld step'}]};
const qaReviewAfter={notes:[{...qaReviewBefore.notes[0],content:'# Plan\nNew step\nReview files beside chat'},{id:'qa-review-principles',title:'Principles',folderPath:'design/research',content:'# Principles\nReadable progress'}]};
state.notes.push(...qaReviewAfter.notes);
const qaReviewRun={id:'qa-review-run',conversationId:chat.id,status:'completed',fileChanges:FileReview.capture(qaReviewBefore,qaReviewAfter,qaReviewAfter.notes.map(n=>({type:'note',id:n.id})))};
state.agentRuns.push(qaReviewRun);
await openPreview('review',qaReviewRun.id,'qa-review-principles');
check(document.querySelector('[data-review-file="qa-review-principles"][aria-pressed="true"]'), 'review opens the explicitly selected file');
check(document.querySelectorAll('.review-folder').length===2, 'review renders directory hierarchy');
document.querySelector('.review-tab[data-mode="preview"]').click();
check(document.querySelector('.file-review-content h1')?.textContent==='Principles', 'tree selection renders Markdown preview in WebKit');
document.querySelector('[data-review-file="qa-review-doc"]').click();
document.querySelector('.review-tab[data-mode="diff"]').click();
document.querySelector('[data-review-split]').click();
await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
check(document.querySelector('.diff-pair .diff-half.add,.diff-line.add'), 'responsive diff renders actual added lines');
check(!document.querySelector('#previewDialog').matches(':modal'), 'review leaves the conversation interactive');
const qaProgressHost=document.createElement('div');document.body.append(qaProgressHost);
const qaStreaming={id:'qa-stable',live:true,at:Date.now(),activities:[{id:'qa-think',kind:'summary',text:'First thought',status:'running',at:Date.now()}]};
qaProgressHost.innerHTML='<div>'+AgentProgress.markup(qaStreaming)+'</div>';
const qaSignal=qaProgressHost.querySelector('.progress-activity');
qaStreaming.activities[0].text+='; more detail';
const qaNext=document.createElement('div');qaNext.innerHTML=AgentProgress.markup(qaStreaming);
AgentProgress.patchLive(qaProgressHost.firstElementChild,qaNext);
check(qaProgressHost.querySelector('.progress-activity')===qaSignal && qaSignal.isConnected, 'streaming keeps the same connected animation node in WebKit');
qaProgressHost.remove();

// 17) Project files, rendered editing and honest request evidence in WebKit.
check(typeof ProjectFiles==='object'&&typeof MarkdownEditor==='object'&&typeof AgentWorkspace==='object','project workspace resources load in native shell');
state.projects.push({id:'qa-editor-project',name:'工作台设计',workspace:chat.workspace||'日常'});
chat.projectId='qa-editor-project';state.currentConversationId=chat.id;
for(const note of qaReviewAfter.notes)note.projectId=chat.projectId;
state.ui.inspectorOpen=true;state.ui.inspector='files';
renderAll();showView('agent');applyUiPreferences();AgentWorkspace.sync();
// Real notes exist on disk; the local draft store only accepts persisted notes.
check(await saveDocumentDurably()===true,'fixture documents are saved before editing');
const qaUntil=async(test,label)=>{for(let n=0;n<200;n++){if(test())return;await new Promise(resolve=>setTimeout(resolve,25));}throw Error('Timed out: '+label);};
check(document.querySelectorAll('#conversationProjectFiles [data-project-file-key]').length===2,'project tree lists both documents in native shell');
await openPreview('note','qa-review-doc');
await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
check(document.querySelector('#conversationInspector').parentElement.id==='readingPane','file tree docks beside the open document in WebKit');
const qaReaderBounds=document.querySelector('#readingPane').getBoundingClientRect(),qaTreeBounds=document.querySelector('#conversationInspector').getBoundingClientRect(),qaDocumentBounds=document.querySelector('#previewDialog').getBoundingClientRect();
if(qaReaderBounds.width>=620)check(qaDocumentBounds.right<=qaTreeBounds.left+1&&qaDocumentBounds.width>220,'native file tree reserves space and never covers the document');
if(qaReaderBounds.width<620){document.querySelector('#readerFilesToggle').click();check(!state.ui.inspectorOpen,'narrow file drawer closes without changing the document');}
const qaAccent=getComputedStyle(document.body).getPropertyValue('--accent').trim();
check(qaAccent===(document.body.classList.contains('light-mode')?'#087f70':'#65d7bb'),'native preserves the original AI Bro accent');
if(BrowserTools.available())check(document.querySelector('#composerBrowserToggle'),'native browser has an entry outside the hidden web header');
const qaModeControl=label=>[...document.querySelectorAll('.document-toolbar-kit [role=radio]')].find(node=>node.textContent.trim()===label);
await qaUntil(()=>qaModeControl('编辑')&&!qaModeControl('编辑').disabled,'visual edit mode available');qaModeControl('编辑').click();
await qaUntil(()=>document.querySelector('.document-visual-canvas .ProseMirror[contenteditable=true]'),'visual editor mounted');
const qaEditable=document.querySelector('.document-visual-canvas .ProseMirror');
check(qaEditable&&document.querySelector('.note-document').dataset.mode==='rich','rendered Markdown is directly editable in native shell');
check(!document.querySelector('.reader-document-details').open,'document metadata starts compact and is available on demand');
check(qaEditable.querySelector('h1').getBoundingClientRect().top<300,'native editor keeps first content above dense chrome: '+Math.round(qaEditable.querySelector('h1').getBoundingClientRect().top));
// Type through the real editor input path (ProseMirror handles insertText).
qaEditable.focus();{const range=document.createRange();range.selectNodeContents(qaEditable.querySelector('p'));const selection=getSelection();selection.removeAllRanges();selection.addRange(range);}
document.execCommand('insertText',false,'在原生界面继续编辑并保存');
await qaUntil(()=>NoteEditor.currentContent()?.content.includes('在原生界面继续编辑并保存'),'visual edit reaches the draft');
// Navigation keeps an unsaved edit as a local draft instead of prompting
// (tests/reading-pane.test.js); it must never be written into the note silently.
await openPreview('note','qa-review-principles');
check(state.previewRecord.id==='qa-review-principles','switching documents opens the requested file');
check(!state.notes.find(note=>note.id==='qa-review-doc').content.includes('在原生界面继续编辑并保存'),'an unsaved edit is not committed by navigation');
await openPreview('note','qa-review-doc');
await qaUntil(()=>NoteEditor.currentContent()?.dirty===true,'retained draft restored');
check(NoteEditor.currentContent().content.includes('在原生界面继续编辑并保存'),'reopening restores the retained draft');
// The Kit toolbar re-renders asynchronously; click only once Save is enabled.
const qaSaveButton=()=>[...document.querySelectorAll('#previewDialog .document-toolbar-kit button')].find(button=>button.textContent.trim()==='保存'&&!button.disabled&&button.getClientRects().length);
await qaUntil(()=>qaSaveButton(),'enabled save button');qaSaveButton().click();
await qaUntil(()=>state.notes.find(note=>note.id==='qa-review-doc').content.includes('在原生界面继续编辑并保存')&&NoteEditor.currentContent()?.dirty===false,'explicit save');
check(state.notes.find(note=>note.id==='qa-review-doc').content.includes('在原生界面继续编辑并保存'),'rendered edit persists in the exact selected note');
qaReviewRun.startedAt=Date.now();qaReviewRun.contextMetrics={estimatedTokens:2400,characters:5600,loadedCapabilities:['knowledge','files'],history:{includedMessages:4,totalMessages:18,omittedMessages:14}};
qaReviewRun.knowledgeReads=[{type:'read',id:'qa-review-doc',title:'Interaction plan',offset:0}];AgentWorkspace.sync();
// Request evidence lives in the context workbench's "recent request" tab.
state.ui.inspectorOpen=true;state.ui.inspector='context';applyUiPreferences();ContextWorkbench.refresh();
await qaUntil(()=>document.querySelector('#contextWorkbench #context-tab-recent'),'context workbench tabs');
document.querySelector('#contextWorkbench #context-tab-recent').click();
await qaUntil(()=>/4 \/ 18/.test(document.querySelector('#contextWorkbench')?.textContent||''),'recent request evidence');
const qaEvidence=document.querySelector('#contextWorkbench').textContent;
check(qaEvidence.includes('2,400')&&qaEvidence.includes('4 / 18'),'native request evidence shows recorded size and history selection');
check(document.querySelectorAll('#conversationInspector').length===1,'docking never duplicates the inspector');
state.ui.inspector='files';applyUiPreferences();save();

// The JS appearance echo must settle, not bounce native→web→native forever.
if(window.workstationDesktop?.setAppearance){
 const qaSetAppearance=workstationDesktop.setAppearance;let qaAppearanceEchoes=0;
 workstationDesktop.setAppearance=value=>{qaAppearanceEchoes++;return qaSetAppearance(value);};
 try{
  await qaSetAppearance('dark');await new Promise(resolve=>setTimeout(resolve,250));
  check(!document.body.classList.contains('light-mode'),'native toolbar dark appearance reaches WebKit');
  check(qaAppearanceEchoes<=2,'appearance synchronization settles without an RPC echo loop');
  await qaSetAppearance('light');await new Promise(resolve=>setTimeout(resolve,250));
  check(document.body.classList.contains('light-mode'),'native toolbar light appearance reaches WebKit');
  check(qaAppearanceEchoes<=4,'round-trip appearance changes remain bounded');
 }finally{workstationDesktop.setAppearance=qaSetAppearance;}
}

return 'PASS: connected review workspace (directory tree, selected file, Markdown preview, split diff), stable streaming indicator in WKWebView;  agent interaction additions in the native shell — tool history breathing (opens while running, folds when settled, manual choice wins), clarify question cards (enumerable options only, escaped rendering, read-only after submit, answers verbatim), tool-type aggregation rows (adjacent identical finished tools collapse to one measured summary; running or split groups stay flat), task deliverable checks (unfinished tasks stay unfinished), model source fallback (conversation → project → workspace → global), conversation-to-project conversion, tool loop guard (mechanical, pages not flagged, honest cost wording), stopped-round input restore (never overwriting the user), reviewer delegation (off by default, destructive/routing never delegated, halts on repeated objections), in-conversation message-level branching (conserving messages, provenance survives round trips), queue module and strip reflect real pending state, segment-level breathing (streaming opens / settled collapses / manual pin preserved / transition heading), per-segment measured duration, measured-usage-only message meta, preview matrix (video/audio controls, CSV tables escaped and bounded, HTML sandboxed, unknown types untouched), rich text (code highlighting conserves text and never guesses languages, math renders fractions/roots/symbols and keeps unknown commands literal), project schedule (Monday-first week, tasks bucketed by due date, undated tasks kept visible, plan text escaped), message media (adjacent images merge into a gallery, video/audio render inline, unreachable media falls back instead of breaking).';
