'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const dictionary = require('../i18n-en.js');
const root = path.join(__dirname, '..');

function translate(value) {
  if (Object.prototype.hasOwnProperty.call(dictionary.exact, value)) return dictionary.exact[value];
  for (const rule of dictionary.patterns) {
    const expression = new RegExp(rule.source);
    if (expression.test(value)) return value.replace(expression, rule.replacement);
  }
  return value;
}

test('English dictionary loads in a browser without DOM, network, or state access', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(root, 'i18n-en.js'), 'utf8'), context);
  assert.equal(context.WorkstationEnglish.exact['日常'], 'Personal');
  assert.equal(context.WorkstationEnglish.patterns.length, dictionary.patterns.length);
  assert.deepEqual(Object.keys(context), ['WorkstationEnglish']);
});

test('dictionary entries are plain interface strings and preserve explicit variables', () => {
  assert.ok(Object.keys(dictionary.exact).length >= 900);
  for (const [source, english] of Object.entries(dictionary.exact)) {
    assert.equal(typeof english, 'string', source);
    assert.ok(english.trim(), source);
    assert.doesNotMatch(english, /<\/?(?:script|iframe|style|img)\b/i, source);
    const placeholders = value => (value.match(/\{[a-zA-Z]+\}/g) || []).sort();
    assert.deepEqual(placeholders(source), placeholders(english), source);
  }
  assert.equal(translate('关闭 {name}'), 'Close {name}');
  assert.equal(translate('已选择 {count} 项'), 'Selected: {count}');
});

const workflows = {
  navigation: ['新对话', '总览', '日常', '课程', '科研', '回收站', '设置', '全部项目'],
  settings: ['界面语言', '保存设置', '测试连接', '切换深色', '切换浅色', '重新查看新手引导'],
  reader: ['资料阅读区', '重新打开阅读区', '恢复并排阅读', '编辑与预览', '保存目录', '保存并继续', '放弃修改', '载入最新版本', 'AI 有新草稿待合并'],
  tasks: ['待开始', '进行中', '已完成', '截止时间', '检查清单', '优先级', '未归属项目'],
  history: ['执行历史', '保留日志', '永久删除日志', '全选筛选结果', '执行记录详情'],
  skills: ['复制为自定义', '保存技能', '删除技能', '工作流说明', '内置'],
  onboarding: ['先连接你的模型', '把材料和指令一起交给 AI', '空间之下，是独立的项目', '让一篇主笔记持续生长', '从总览开始行动', '跳过新手引导'],
  sync: ['账号与云同步', '纯本地', '同步中', '已同步', '离线待重试'],
  sources: ['待 AI 分析', '已分析 · 已关联', '知识与资料', '项目与来源', '可搜索文字（后台索引）']
};
for (const [workflow, keys] of Object.entries(workflows)) {
  test(`English labels cover the ${workflow} workflow`, () => {
    for (const key of keys) {
      assert.ok(Object.prototype.hasOwnProperty.call(dictionary.exact, key), `Missing: ${key}`);
      assert.notEqual(translate(key), key, `Untranslated: ${key}`);
    }
  });
}

test('current static HTML interface labels and accessibility text have translations', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
    .replace(/<!--[^]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[^]*?<\/\1>/gi, '');
  const decode = value => value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const labels = [...html.matchAll(/>([^<>]+)</g)].map(match => decode(match[1].trim()));
  for (const match of html.matchAll(/\b(?:title|placeholder|aria-label)=(['"])(.*?)\1/g)) labels.push(decode(match[2].trim()));
  const missing = [...new Set(labels.filter(value => /[\u3400-\u9fff]/.test(value) && translate(value) === value))];
  assert.deepEqual(missing, []);
});

test('numeric patterns are anchored and never capture arbitrary user names or content', () => {
  const seen = new Set();
  for (const rule of dictionary.patterns) {
    assert.ok(rule.source.startsWith('^') && rule.source.endsWith('$'), rule.source);
    assert.doesNotThrow(() => new RegExp(rule.source));
    assert.ok(!seen.has(rule.source), `Duplicate: ${rule.source}`);
    seen.add(rule.source);
    assert.doesNotMatch(rule.source, /\.\*|\.\+|\\[sSwW]|\[\^/, rule.source);
    assert.equal(typeof rule.replacement, 'string');
  }
  for (const text of [
    '我的阅读区 · 3', '阅读区 · 我的论文', '已选择 我的研究 项',
    '论文说明：已选择 2 项', '已选择 2 项，这是我的笔记正文',
    '智能系统基础数学理论和算法', '阅读区 · 2.pdf',
    '3 个项目 · 2 个任务 · 4 条知识 · 我的实验 份资料',
    '# 总览\n这是我自己写的课程笔记。', '<img src=x onerror=alert(1)>'
  ]) assert.equal(translate(text), text);
});

test('counts, sorting, public run states and onboarding counters render in English', () => {
  const examples = {
    '阅读区 · 3': 'Reader · 3',
    '历史版本 · 4 / 20': 'Version history · 4 / 20',
    '1,235 字符 · 已载入 AI 草稿': '1,235 characters · AI draft loaded',
    '已选择 12 项': 'Selected: 12',
    '交给 AI 分析 · 2 份': 'Analyze with AI · 2 sources',
    '更新时间 ↓': 'Updated ↓',
    '3 个项目 · 2 个任务 · 4 条知识 · 6 份资料': 'Projects: 3 · Tasks: 2 · Notes: 4 · Sources: 6',
    '3/5 个任务已完成': '3/5 tasks complete',
    '第 47 / 145 页': 'Page 47 / 145',
    '科研 · 按天统计已完成任务与收集资料': 'Research · Daily completed tasks and collected sources',
    '4 / 5 · 原件与 Markdown 文档并排阅读': '4 / 5 · Read originals and Markdown side by side',
    '● 执行 12 项操作': '● Running 12 actions',
    '● 等待审批': '● Awaiting approval',
    '3 条待上传 · 2 项冲突': 'Pending uploads: 3 · Conflicts: 2'
  };
  for (const [chinese, english] of Object.entries(examples)) assert.equal(translate(chinese), english, chinese);
});

test('dictionary lookup does not rewrite persisted IDs or the supplied user state', () => {
  const state = { projects: [{ id: 'p1', name: '总览', workspace: '科研' }], notes: [{ title: '阅读区 · 3', content: '保存设置' }] };
  const before = JSON.stringify(state);
  assert.equal(translate(state.projects[0].workspace), 'Research');
  assert.equal(JSON.stringify(state), before);
  assert.equal(state.projects[0].workspace, '科研');
});
test('recorded research and citation shell labels, page counts and relative updates have English equivalents',()=>{
  const examples={
    '全部':'All','待审阅':'Needs review','已审阅':'Reviewed',
    '实线：明确引用':'Solid: explicit citation','虚线：共同标签':'Dashed: shared tags','点线：同项目':'Dotted: same project',
    '点击节点查看论文。':'Select a node to open its paper.',
    '共同标签和项目关系不代表相互引用。':'Shared tags or projects do not imply citations.',
    '当前显示前 24 篇。':'Showing the first 24 papers.',
    '已参考项目资料 · 4 项':'Project sources referenced · 4','网页来源 · 2 项':'Web sources · 2',
    '第 1 页':'Page 1','刚刚更新':'Updated just now','1 天前更新':'Updated 1 day ago','2 天前更新':'Updated 2 days ago','10 分钟前更新':'Updated 10 min ago','3 小时前更新':'Updated 3 hr ago','中':'Medium'
  };
  for(const [chinese,english] of Object.entries(examples))assert.equal(translate(chinese),english,chinese);
});
