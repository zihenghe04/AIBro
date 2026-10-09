import {test,expect} from '@playwright/test';
const APP='http://127.0.0.1:8899';
test.use({viewport:{width:390,height:844},isMobile:true,hasTouch:true,locale:'zh-CN',serviceWorkers:'block'});
async function seed(page) {
 await page.route('**/__edit043',r=>r.fulfill({contentType:'text/html',body:'<title>synthetic</title>'}));
 await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.fallback():r.abort());
 await page.goto(APP+'/__edit043');
 await page.evaluate(async()=>{
  const {Store,MemoryAdapter}=await import('/src/store.js'),{createEditorDraft}=await import('/src/editor-draft.js');
  const s=await new Store(new MemoryAdapter()).load();
  await s.put('projects',{id:'p',name:'科研项目',workspace:'科研'});
  await s.put('tasks',{id:'t',title:'核对实验记录',description:'Mac说明',projectId:'p',project:'科研项目',workspace:'科研',status:'in_progress',priority:'high',completedAt:123,createdAt:1,updatedAt:2});
  const old={id:'n',title:'实验记录',content:'旧正文',workspace:'科研',kind:'note',updatedAt:1};
  await s.put('notes',{...old,content:'Mac最新正文',updatedAt:2});
  s.state.drafts['editor:n']=createEditorDraft('note',old,{title:'实验记录',content:'手机未保存草稿'});
  await s.put('notes',{id:'legacy',title:'旧版本草稿',content:'电脑正文',workspace:'课程',kind:'note',updatedAt:2});
  s.state.drafts['editor:legacy']={title:'旧草稿标题',content:'旧手机草稿'};
  await s.put('notes',{id:'a',title:'随记A',content:'A原文',kind:'随记',workspace:'科研',projectId:'p',project:'科研项目',updatedAt:1});
  await s.put('notes',{id:'b',title:'随记B',content:'B原文',kind:'随记',workspace:'课程',updatedAt:1});
  await new Promise((resolve,reject)=>{const r=indexedDB.open('aibro-mobile-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('state');r.onsuccess=()=>{const db=r.result,t=db.transaction('state','readwrite');t.objectStore('state').put(s.state,'workspace');t.oncomplete=()=>{db.close();resolve()};t.onerror=()=>reject(t.error)};r.onerror=()=>reject(r.error)});
 });
 await page.goto(APP);await expect(page.locator('.mobile-planner')).toBeVisible();
}
async function state(page){return page.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('aibro-mobile-v1',1);r.onsuccess=()=>{const db=r.result,t=db.transaction('state'),q=t.objectStore('state').get('workspace');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);t.oncomplete=()=>db.close()};r.onerror=()=>reject(r.error)}));}
async function openNote(page,id){await page.locator('nav [data-tab=knowledge]').click();await page.locator(`[data-action=note][data-id="${id}"]`).click();}

test('Mac task state and ownership survive description edits; explicit unlink clears legacy name',async({page})=>{
 await seed(page);await page.locator('.mobile-planner__modes button').filter({hasText:'待办'}).click();
 await expect(page.locator('[data-planner-id=t]')).toContainText('进行中');await page.locator('[data-planner-id=t]').click();
 await expect(page.locator('#task-form [name=status]')).toHaveValue('in_progress');
 await page.locator('#task-form [name=description]').fill('手机补充说明');await page.getByRole('button',{name:'保存任务',exact:true}).click();await expect(page.locator('#sheet')).not.toBeVisible();
 let t=(await state(page)).records['tasks:t'].data;expect(t).toMatchObject({status:'in_progress',completedAt:123,projectId:'p',project:'科研项目',workspace:'科研'});
 await page.locator('[data-planner-id=t]').click();await page.locator('[name=project]').selectOption('');await page.getByRole('button',{name:'保存任务',exact:true}).click();await expect(page.locator('#sheet')).not.toBeVisible();
 t=(await state(page)).records['tasks:t'].data;expect(t).toMatchObject({projectId:null,project:null,workspace:'科研',status:'in_progress',completedAt:123});
});

test('changed and legacy drafts cannot overwrite Mac after reopen; user can inspect then save a separate copy',async({page},info)=>{
 await page.setViewportSize({width:320,height:760});await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});await seed(page);
 await openNote(page,'n');await expect(page.locator('[data-editor-recovery=changed]')).toBeVisible();
 await page.locator('[data-document-control=edit]').click();await expect(page.locator('[data-document-control=save]')).toBeDisabled();
 await expect(page.locator('#note-form textarea')).toHaveValue('手机未保存草稿');
 await page.getByRole('button',{name:'查看最新内容',exact:true}).click();await expect(page.locator('#sheet article')).toContainText('Mac最新正文');
 await page.locator('#sheet [data-action=close]').click();await page.locator('[data-action=note][data-id=n]').click();await expect(page.locator('[data-editor-recovery=changed]')).toBeVisible();
 await page.screenshot({path:info.outputPath('draft-recovery-dark-320.png'),animations:'disabled'});
 expect(await page.locator('#sheet').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBeTruthy();
 await page.getByRole('button',{name:'另存为新资料',exact:true}).click();await expect(page.locator('#sheet h2')).toHaveText('实验记录（草稿副本）');
 let s=await state(page);expect(s.records['notes:n'].data.content).toBe('Mac最新正文');expect(s.drafts['editor:n']).toBeUndefined();
 expect(Object.values(s.records).find(r=>r.data?.title==='实验记录（草稿副本）').data.content).toBe('手机未保存草稿');
 await page.locator('#sheet [data-action=close]').click();await openNote(page,'legacy');await expect(page.locator('[data-editor-recovery=legacy]')).toBeVisible();
 await page.locator('#sheet [data-action=close]').click();await page.reload();await openNote(page,'legacy');await expect(page.locator('[data-editor-recovery=legacy]')).toBeVisible();
 s=await state(page);expect(s.records['notes:legacy'].data.content).toBe('电脑正文');expect(s.drafts['editor:legacy'].content).toBe('旧手机草稿');
});

test('capture upload holds its record and workspace while closing is blocked; all fields persist as baseline-aware draft',async({page})=>{
 await seed(page);await page.locator('nav [data-tab=captures]').click();await page.locator('[data-action=note][data-id=a]').click();
 await page.locator('#capture-form [name=content]').fill('A手机修改');await page.locator('#capture-form [name=tags]').fill('合成,检查');
 await expect.poll(async()=>((await state(page)).drafts['capture:a']?.values?.tags)).toBe('合成,检查');
 await page.evaluate(()=>{const original=File.prototype.arrayBuffer;File.prototype.arrayBuffer=async function(){await new Promise(resolve=>window.finishFile=resolve);return original.call(this)}});
 await page.locator('#capture-form [name=files]').setInputFiles({name:'synthetic.txt',mimeType:'text/plain',buffer:Buffer.from('synthetic file')});
 await page.locator('#capture-form button[type=submit]').click();await page.waitForFunction(()=>!!window.finishFile);
 await expect(page.locator('#sheet [data-action=close]')).toBeDisabled();await page.keyboard.press('Escape');await expect(page.locator('#capture-form')).toBeVisible();
 await page.evaluate(()=>window.finishFile());await expect(page.locator('#sheet')).not.toBeVisible();
 const s=await state(page);expect(s.records['notes:a'].data).toMatchObject({content:'A手机修改',tags:['合成','检查'],workspace:'科研',projectId:'p',project:'科研项目'});
 expect(s.records['notes:a'].data.sourceAttachmentIds).toHaveLength(1);expect(s.records['notes:b'].data.content).toBe('B原文');expect(s.drafts['capture:a']).toBeUndefined();
});
