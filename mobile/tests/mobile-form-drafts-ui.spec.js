import {test,expect} from '@playwright/test';
const APP='http://127.0.0.1:8899';
test.use({viewport:{width:320,height:760},isMobile:true,hasTouch:true,locale:'zh-CN',timezoneId:'Asia/Shanghai',serviceWorkers:'block'});
test.setTimeout(30000);
async function seed(page) {
  await page.route('**/__forms047',route=>route.fulfill({contentType:'text/html',body:'<title>synthetic form drafts</title>'}));
  await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.fallback():route.abort());
  await page.goto(APP+'/__forms047');
  await page.evaluate(async()=>{
    const {Store,MemoryAdapter}=await import('/src/store.js'),store=await new Store(new MemoryAdapter()).load();
    await store.put('projects',{id:'synthetic_p',name:'合成项目',workspace:'科研'});
    await store.put('tasks',{id:'synthetic_t',title:'合成任务',description:'Mac 原说明',projectId:'synthetic_p',workspace:'科研',status:'in_progress',priority:'high',dueAt:'2030-01-02',checklist:[{id:'check-original',text:'原清单',done:false,custom:'retain'}],updatedAt:1});
    await new Promise((resolve,reject)=>{const r=indexedDB.open('aibro-mobile-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('state');r.onsuccess=()=>{const db=r.result,tx=db.transaction('state','readwrite');tx.objectStore('state').put(store.state,'workspace');tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error)};r.onerror=()=>reject(r.error)});
  });
  await page.goto(APP); await expect(page.locator('.mobile-planner')).toBeVisible();
}
async function saved(page) {return page.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('aibro-mobile-v1',1);r.onsuccess=()=>{const db=r.result,tx=db.transaction('state'),q=tx.objectStore('state').get('workspace');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);tx.oncomplete=()=>db.close()};r.onerror=()=>reject(r.error)}));}
async function task(page) {await page.locator('.mobile-planner__modes button').filter({hasText:'待办'}).click();await page.locator('[data-planner-id=synthetic_t]').click();await expect(page.locator('#task-form')).toBeVisible();}
async function captureActualStore(page) {await page.evaluate(async()=>{const {Store}=await import('/src/store.js');const original=Store.prototype.tx;Store.prototype.tx=function(fn){window.syntheticFormStore=this;return original.call(this,fn)};});}

test('new recurring agenda retains raw dates and input through Close and reload, then saves once and clears only its draft',async({page},info)=>{
  await seed(page); await page.getByRole('button',{name:'新建日程',exact:true}).click();
  const form=page.locator('#event-form');
  await form.locator('[name=title]').fill('合成每周讨论');await form.locator('[name=start]').fill('2030-01-02T15:00');await form.locator('[name=end]').fill('2030-01-02T16:00');
  await form.locator('[name=details]').fill(' 未保存的备注\n第二行');await form.locator('[name=frequency]').selectOption('weekly');
  await form.locator('[name=repeatDay][value="2"]').check();await form.locator('[name=repeatCount]').fill('8');
  await page.locator('#sheet [data-action=close]').click();await expect(page.locator('#sheet')).not.toBeVisible();
  let state=await saved(page);expect(Object.keys(state.records).filter(k=>k.startsWith('notes:'))).toHaveLength(0);
  const originalDraft=state.drafts['form:event:new'];expect(originalDraft.values).toMatchObject({title:'合成每周讨论',start:'2030-01-02T15:00',details:' 未保存的备注\n第二行',repeatCount:'8'});
  await page.reload();await page.getByRole('button',{name:'新建日程',exact:true}).click();
  await expect(form.locator('[name=title]')).toHaveValue('合成每周讨论');await expect(form.locator('[name=start]')).toHaveValue('2030-01-02T15:00');
  await expect(form.locator('[name=frequency]')).toHaveValue('weekly');await expect(form.locator('[name=repeatDay][value="2"]')).toBeChecked();
  await expect(page.locator('[data-form-draft-state=ready]')).toContainText('草稿保存在本机');
  await page.screenshot({path:info.outputPath('agenda-draft-320.png'),animations:'disabled'});
  expect(await page.locator('#sheet').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBeTruthy();
  await page.getByRole('button',{name:'添加日程',exact:true}).click();await expect(page.locator('#sheet')).not.toBeVisible();
  state=await saved(page);const notes=Object.entries(state.records).filter(([k])=>k.startsWith('notes:'));
  expect(notes).toHaveLength(1);expect(state.drafts['form:event:new']).toBeUndefined();
  expect(JSON.parse(notes[0][1].data.content)).toMatchObject({title:'合成每周讨论',timeZone:'Asia/Shanghai',recurrence:{frequency:'weekly',count:8}});
});

test('task draft keeps checklist identity, cannot overwrite a live sync update, and explicit discard opens the latest record',async({page},info)=>{
  await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});await seed(page);await task(page);await captureActualStore(page);
  const form=page.locator('#task-form');await form.locator('[name=description]').fill('手机未保存说明');
  await form.locator('.task-checklist-row input[type=text]').fill('手机清单草稿');
  await expect.poll(async()=>((await saved(page)).drafts['form:task:record:synthetic_t']?.values.description)).toBe('手机未保存说明');
  await page.evaluate(async()=>{const s=window.syntheticFormStore,t=s.get('tasks','synthetic_t');await s.put('tasks',{...t,description:'Mac 最新说明',updatedAt:2});});
  await expect(page.locator('[data-form-draft-state=changed]')).toBeVisible();await expect(page.getByRole('button',{name:'保存任务',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'查看最新内容',exact:true}).click();await expect(page.locator('.form-latest')).toContainText('Mac 最新说明');
  await page.getByRole('button',{name:'返回草稿',exact:true}).click();await expect(form.locator('[name=description]')).toHaveValue('手机未保存说明');
  await page.screenshot({path:info.outputPath('task-draft-conflict-dark-320.png'),animations:'disabled'});
  await page.locator('#sheet [data-action=close]').click();await page.reload();await task(page);
  await expect(page.locator('[data-form-draft-state=changed]')).toBeVisible();await expect(form.locator('[name=description]')).toHaveValue('手机未保存说明');
  let state=await saved(page);expect(state.records['tasks:synthetic_t'].data.description).toBe('Mac 最新说明');expect(state.drafts['form:task:record:synthetic_t'].base.updatedAt).toBe(1);
  await page.getByRole('button',{name:'丢弃草稿',exact:true}).click();await expect(form.locator('[name=description]')).toHaveValue('Mac 最新说明');
  await form.locator('[name=description]').fill('基于最新版本补充');await page.getByRole('button',{name:'保存任务',exact:true}).click();await expect(page.locator('#sheet')).not.toBeVisible();
  state=await saved(page);expect(state.drafts['form:task:record:synthetic_t']).toBeUndefined();expect(state.records['tasks:synthetic_t'].data).toMatchObject({description:'基于最新版本补充',dueAt:'2030-01-02',status:'in_progress',checklist:[{id:'check-original',text:'原清单',done:false,custom:'retain'}]});
});

test('storage failure leaves the task form open and the original plus draft intact, then explicit retry saves',async({page})=>{
  await seed(page);await task(page);await captureActualStore(page);
  await page.locator('#task-form [name=description]').fill('磁盘失败仍保留');await expect.poll(async()=>((await saved(page)).drafts['form:task:record:synthetic_t']?.values.description)).toBe('磁盘失败仍保留');
  await page.evaluate(()=>{const s=window.syntheticFormStore,original=s.adapter.write.bind(s.adapter);s.adapter.write=async value=>{if(value.records['tasks:synthetic_t'].data.description==='磁盘失败仍保留'&&!window.allowSyntheticFormSave)throw Error('合成存储失败');return original(value)};});
  await page.getByRole('button',{name:'保存任务',exact:true}).click();await expect(page.locator('#task-form')).toBeVisible();await expect(page.locator('#toast')).toContainText('合成存储失败');
  let state=await saved(page);expect(state.records['tasks:synthetic_t'].data.description).toBe('Mac 原说明');expect(state.drafts['form:task:record:synthetic_t'].values.description).toBe('磁盘失败仍保留');
  await page.evaluate(()=>window.allowSyntheticFormSave=true);await page.getByRole('button',{name:'保存任务',exact:true}).click();await expect(page.locator('#sheet')).not.toBeVisible();
  state=await saved(page);expect(state.records['tasks:synthetic_t'].data.description).toBe('磁盘失败仍保留');expect(state.drafts['form:task:record:synthetic_t']).toBeUndefined();
});

test('task and agenda input stays readable after keyboard-sized viewport reduction and save remains reachable',async({page},info)=>{
  await seed(page);await task(page);
  const description=page.locator('#task-form [name=description]');
  await description.fill('聚焦时键盘缩小可见区域，输入不能被保存栏遮住。');
  await page.setViewportSize({width:320,height:305});
  await expect(page.locator('body')).toHaveClass(/keyboard-open/);
  const readable=async selector=>page.locator(selector).evaluate(el=>{
    const r=el.getBoundingClientRect(),head=document.querySelector('#sheet .sheet-head').getBoundingClientRect();
    const points=[r.top+Math.min(20,r.height/2),r.bottom-Math.min(20,r.height/2)];
    return {focused:document.activeElement===el,inside:r.top>=Math.max(0,head.bottom)+2&&r.bottom<=innerHeight-2,
      unoccluded:points.every(y=>document.elementFromPoint(r.left+r.width/2,y)===el),top:r.top,bottom:r.bottom,head:head.bottom,height:innerHeight};
  });
  await expect.poll(async()=>{const x=await readable('#task-form [name=description]');return x.focused&&x.inside&&x.unoccluded;}, {message:'focused task textarea must remain above keyboard and outside sticky surfaces'}).toBe(true);
  await page.screenshot({path:info.outputPath('task-input-short-305.png'),animations:'disabled'});
  await page.getByRole('button',{name:'保存任务',exact:true}).click();await expect(page.locator('#sheet')).not.toBeVisible();
  await page.setViewportSize({width:320,height:760});await page.locator('.mobile-planner__modes button').filter({hasText:'日程'}).click();
  await page.getByRole('button',{name:'新建日程',exact:true}).click();
  await page.locator('#event-form [name=title]').fill('合成短视口日程');
  const details=page.locator('#event-form [name=details]');await details.fill('日程备注也需要在键盘上方完整显示');
  await page.setViewportSize({width:320,height:305});await expect(page.locator('body')).toHaveClass(/keyboard-open/);
  await expect.poll(async()=>{const x=await readable('#event-form [name=details]');return x.focused&&x.inside&&x.unoccluded;}, {message:'focused agenda textarea must remain visible after resize'}).toBe(true);
  await page.screenshot({path:info.outputPath('agenda-input-short-305.png'),animations:'disabled'});
  await page.getByRole('button',{name:'添加日程',exact:true}).click();await expect(page.locator('#sheet')).not.toBeVisible();
  const state=await saved(page);expect(state.records['tasks:synthetic_t'].data.description).toContain('聚焦时键盘');
  expect(Object.values(state.records).some(r=>r.data?.title==='合成短视口日程')).toBe(true);
});
