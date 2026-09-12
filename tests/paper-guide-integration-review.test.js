const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Skills = require('../skills-core');
const Web = require('../conversation-web');
const source = fs.readFileSync(require.resolve('../app'), 'utf8');
const sendStart = source.indexOf('async function sendMessage(');
const start = source.indexOf('    const paperWorkflow =', sendStart);
const end = source.indexOf('    const retrievalQuery =', start);
assert.ok(start > sendStart && end > start, 'Evaluate the actual sendMessage paper/skill injection, not a mirrored implementation');
function prompt(goal, { skillId = null, enabled = true } = {}) {
  const state = { settings: { skillsEnabled: enabled }, papers: [] };
  const conversation = { id: 'fixture-conversation', skillId };
  const WorkstationSkills = { instructions: (value, current) => Skills.instructions(value, current) };
  const context = vm.createContext({ goal, state, conversation, visiblePaper: () => true,
    WorkstationSkills, WorkstationSkillsCore: Skills, ConversationWeb: Web,
    window: { WorkstationSkills, WorkstationSkillsCore: Skills, ConversationWeb: Web },
    run: { workspace: 'auto', webSearch: false }, instruction: '' });
  vm.runInContext(source.slice(start, end), context);
  return { text: context.instruction, workspace: context.run.workspace };
}
const occurrences = text => text.split('论文深读标准（工作站适配版）').length - 1;

test('automatic paper requests and arXiv links receive the adapted guide exactly once', () => {
  for (const goal of ['请阅读这篇论文并保存笔记', '分析 https://arxiv.org/abs/1234.56789']) {
    const result = prompt(goal);
    assert.equal(occurrences(result.text), 1);
    assert.equal(result.workspace, '科研');
    assert.match(result.text, /counterArguments.*dataGaps/);
    assert.match(result.text, /不自动设置 reviewed=true/);
    assert.doesNotMatch(result.text, /\/Users\/|\.obsidian/);
  }
});

test('selected paper skill and task-level fallback avoid duplicated guide instructions', () => {
  for (const enabled of [true, false]) {
    const result = prompt('继续分析', { skillId: 'builtin-paper', enabled });
    assert.equal(occurrences(result.text), 1);
    assert.match(result.text, /只问答、比较或核对时遵守用户要求，不自动修改资料/);
  }
});

test('ordinary course or daily requests do not inherit the research template', () => {
  for (const goal of ['请把这份课件整理成课程笔记', '明天下午三点取两张五十元纸币']) {
    const result = prompt(goal);
    assert.equal(occurrences(result.text), 0);
    assert.equal(result.workspace, 'auto');
  }
});
