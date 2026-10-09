import { test, expect } from '@playwright/test';
const APP='http://127.0.0.1:8899';
test.use({viewport:{width:390,height:844},isMobile:true,hasTouch:true,locale:'zh-CN',timezoneId:'Asia/Shanghai',serviceWorkers:'block'});
async function seed(page) {
  await page.clock.setFixedTime(new Date('2030-01-07T12:00:00+08:00'));
  await page.route('**/__home042',r=>r.fulfill({contentType:'text/html',body:'<title>synthetic</title>'}));
  await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.fallback():r.abort());
  await page.goto(APP+'/__home042');
  await page.evaluate(async()=>{
    const {Store,MemoryAdapter}=await import('/src/store.js');const s=await new Store(new MemoryAdapter()).load();
    await s.put('tasks',{id:'undated',title:'整理阅读清单',description:'保留问题与原文页码，准备下一次讨论。',workspace:'科研',status:'todo',checklist:[{id:'mac-1',title:'核对原文',done:false,sourceId:'paper-a'},'列出问题'],customField:'preserve',createdAt:1,updatedAt:1});
    await s.put('tasks',{id:'done',title:'已完成的摘要',status:'done',completedAt:2});
    await s.put('tasks',{id:'date-only',title:'提交读书报告',workspace:'课程',status:'todo',dueAt:'2030-01-06',priority:'high',createdAt:2});
    await s.put('projects',{id:'p',name:'交互设计课程',workspace:'课程',description:'课程作业与阅读资料'});
    await s.put('conversations',{id:'c',title:'梳理这周的阅读与作业安排',projectId:'p',updatedAt:2});
    await new Promise((resolve,reject)=>{const r=indexedDB.open('aibro-mobile-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('state');r.onsuccess=()=>{const db=r.result,t=db.transaction('state','readwrite');t.objectStore('state').put(s.state,'workspace');t.oncomplete=()=>{db.close();resolve()};t.onerror=()=>reject(t.error)};r.onerror=()=>reject(r.error)});
  });
  await page.goto(APP);await expect(page.locator('.mobile-planner')).toBeVisible();
}
async function state(page){return page.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('aibro-mobile-v1',1);r.onsuccess=()=>{const db=r.result,t=db.transaction('state'),q=t.objectStore('state').get('workspace');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);t.oncomplete=()=>db.close()};r.onerror=()=>reject(r.error)}));}
async function tasks(page){await page.locator('.mobile-planner__modes button').filter({hasText:'待办'}).click();}

test('standalone tasks remain discoverable and Mac checklist identity survives editing and completion',async({page},info)=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await seed(page);await tasks(page);
  await expect(page.locator('[data-planner-id=undated]')).toBeVisible();
  await expect(page.locator('[data-planner-id=done]')).toHaveCount(0);
  await page.screenshot({path:info.outputPath('home-tasks-light-390.png'),fullPage:true});
  await page.locator('[data-planner-id=undated]').click();
  await expect(page.locator('#task-form [name=description]')).toHaveValue('保留问题与原文页码，准备下一次讨论。');
  await page.locator('.task-checklist-row input[type=checkbox]').first().check();
  await page.locator('#task-form [name=description]').fill('已经核对原文；继续列出两个问题。');
  await page.getByRole('button',{name:'保存任务',exact:true}).click();
  await expect(page.locator('#sheet')).not.toBeVisible();
  let saved=(await state(page)).records['tasks:undated'].data;
  expect(saved.workspace).toBe('科研');expect(saved.customField).toBe('preserve');expect(saved.checklist[0]).toEqual({id:'mac-1',title:'核对原文',done:true,sourceId:'paper-a'});expect(saved.checklist[1]).toBe('列出问题');
  await page.locator('[data-planner-id=undated]').click();
  await expect(page.locator('.task-checklist-row input[type=checkbox]').first()).toBeChecked();
  await page.screenshot({path:info.outputPath('task-details-light-390.png'),animations:'disabled'});
  await page.getByRole('button',{name:'标记完成',exact:true}).click();await expect(page.locator('#sheet')).not.toBeVisible();
  await expect(page.locator('[data-planner-id=undated]')).toHaveCount(0);
  await page.getByRole('button',{name:'查看已完成待办',exact:true}).click();await expect(page.locator('[data-planner-id=undated]')).toBeVisible();
  await page.reload();await tasks(page);await page.getByRole('button',{name:'查看已完成待办',exact:true}).click();await page.locator('[data-planner-id=undated]').click();
  await expect(page.getByRole('button',{name:'重新打开',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'重新打开',exact:true}).click();await page.getByRole('button',{name:'查看未完成待办',exact:true}).click();await expect(page.locator('[data-planner-id=undated]')).toBeVisible();
  expect(errors).toEqual([]);
});

test('future calendar navigation creates on that date and narrow dark layout fits',async({page},info)=>{
  await page.setViewportSize({width:320,height:760});await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});await seed(page);
  await page.locator('#home-planner-day').fill('2030-05-16');
  await expect(page.locator('[data-planner-day="2030-05-16"]')).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('.mobile-planner__empty')).toHaveText('这天还没有安排');
  await page.getByRole('button',{name:'新建日程',exact:true}).click();
  await expect(page.locator('#event-form [name=start]')).toHaveValue('2030-05-16T09:00');
  await page.locator('#event-form [name=title]').fill('准备期末汇报');
  await page.locator('#event-form button[type=submit]').click();await expect(page.locator('#sheet')).not.toBeVisible();
  await expect(page.locator('[data-planner-type=event]')).toContainText('准备期末汇报');
  await page.screenshot({path:info.outputPath('home-agenda-dark-320.png'),fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  const note=Object.values((await state(page)).records).find(r=>r.data?.title==='准备期末汇报').data;
  expect(new Date(JSON.parse(note.content).start).toISOString()).toBe('2030-05-16T01:00:00.000Z');
  await tasks(page);await page.locator('[data-planner-id=date-only]').click();
  await page.locator('#task-form [name=title]').fill('提交读书报告（已检查）');await page.getByRole('button',{name:'保存任务',exact:true}).click();
  expect((await state(page)).records['tasks:date-only'].data.dueAt).toBe('2030-01-06');
});

test('planner changes preserve home draft node and keyboard entry does not create an empty chat',async({page})=>{
  await seed(page);await page.locator('#home-chat-text').fill('还没说完的一段话');
  const original=await page.locator('#home-chat-text').elementHandle();await tasks(page);
  expect(await original.evaluate(node=>node.isConnected)).toBeTruthy();
  await page.getByRole('button',{name:'键盘输入',exact:true}).click();await expect(page.locator('#home-chat-text')).toBeFocused();
  await expect(page.locator('#home-chat-text')).toHaveValue('还没说完的一段话');
  expect(Object.keys((await state(page)).records).filter(k=>k.startsWith('conversations:'))).toHaveLength(1);
  await page.getByRole('button',{name:'查看全部对话',exact:true}).click();await expect(page.locator('main[data-route=chat]')).toBeVisible();
  await page.locator('[data-action=conversation][data-id=c]').click();await expect(page.getByRole('button',{name:'在当前对话语音输入',exact:true})).toBeVisible();
  await page.locator('nav [data-tab=today]').click();await expect(page.locator('#home-chat-text')).toHaveValue('还没说完的一段话');
});
