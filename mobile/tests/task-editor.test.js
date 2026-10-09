import test from 'node:test';
import assert from 'node:assert/strict';
import { taskChecklistRows, editedChecklist, unchangedTaskDate } from '../src/task-editor.js';

test('phone checklist edits preserve desktop IDs and extension fields', () => {
  const task={checklist:[{id:'mac-step',title:'原步骤',done:false,sourceId:'paper-1'},'旧文本步骤',{id:'other',text:'不动',done:true}]};
  const rows=taskChecklistRows(task);
  rows[0].done=true;rows[0].text='修订步骤';
  assert.deepEqual(editedChecklist(task,rows),[{id:'mac-step',title:'修订步骤',done:true,sourceId:'paper-1'},'旧文本步骤',{id:'other',text:'不动',done:true}]);
  assert.equal(task.checklist[0].done,false);
});
test('removal and new checklist rows do not shift original identity', () => {
  const task={checklist:[{id:'a',text:'删除',done:false},{id:'b',text:'保留',done:false}]};
  const rows=[taskChecklistRows(task)[1],{index:null,text:'新增',done:false}];
  assert.deepEqual(editedChecklist(task,rows),[{id:'b',text:'保留',done:false},{text:'新增',done:false}]);
  assert.throws(()=>editedChecklist(task,[{index:null,text:'  ',done:false}]),/空白/);
});
test('untouched date-only deadlines and millisecond values survive edits', () => {
  assert.equal(unchangedTaskDate('2030-02-04T09:00','2030-02-04T09:00','2030-02-04'),'2030-02-04');
  assert.equal(unchangedTaskDate('2030-02-04T09:00','2030-02-04T09:00',1896426000000),1896426000000);
  assert.equal(unchangedTaskDate('','',''), '');
  assert.equal(unchangedTaskDate('', '2030-02-04T09:00', '2030-02-04'),null);
  assert.throws(()=>unchangedTaskDate('invalid','','2030-02-04'),/有效/);
});
