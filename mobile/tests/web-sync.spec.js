import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
let child, base;
test.beforeAll(async () => {
  child=spawn('/opt/homebrew/bin/python3.12',['tests/cloud-fixture.py'],{env:{...process.env,CLOUD_WEB_ORIGINS:'http://127.0.0.1:8900'}});
  const [chunk]=await once(child.stdout,'data');base='http://127.0.0.1:'+String(chunk).trim();
});
test.afterAll(()=>child?.kill());
async function login(page) {
  await page.goto('http://127.0.0.1:8900/');
  await page.getByRole('button',{name:'⚙',exact:true}).click();
  await page.locator('#sync-form [name=server]').fill(base);
  await page.locator('#sync-form [name=username]').fill('mobile-test');
  await page.locator('#sync-form [name=password]').fill('fixture-password-42!');
  await page.locator('#sync-form [name=merge]').check();
  await page.locator('#sync-form button[type=submit]').click();
  await expect(page.locator('.settings-card').first()).toContainText('已同步');
}
test('built Web uses actual CORS server, preserves offline edits and syncs original files to a second browser',async({browser})=>{
  test.setTimeout(60000);
  const a=await browser.newContext(), b=await browser.newContext();
  try {
    const p=await a.newPage(),q=await b.newPage();
    await login(p); await login(q);
    await p.evaluate(()=>navigator.serviceWorker.ready);
    await p.reload();
    await expect(p.getByRole('heading',{name:'今天',exact:true})).toBeVisible();
    await a.setOffline(true);
    await p.reload();
    await p.getByRole('button',{name:'✎ 记个想法'}).click();
    await p.locator('#capture-form textarea').fill('Web 离线实验记录：跨设备可继续整理。');
    await p.locator('input[name=files]').setInputFiles({name:'实验资料.txt',mimeType:'text/plain',buffer:Buffer.from('cross device original bytes')});
    await p.getByRole('button',{name:'保存随记',exact:true}).click();
    await expect(p.locator('#sheet')).not.toBeVisible();
    await p.reload();
    await p.locator('nav [data-tab=captures]').click();
    await expect(p.locator('.capture-card')).toContainText('Web 离线实验记录');
    const duplicate=await a.newPage();await duplicate.goto('http://127.0.0.1:8900/');
    await expect(duplicate.locator('main')).toContainText('已在另一个标签页打开');await duplicate.close();
    await a.setOffline(false);
    await p.getByRole('button',{name:'⚙',exact:true}).click();
    await p.locator('[data-action=sync]').click();
    await expect(p.locator('.settings-card').first()).toContainText('已同步');
    await q.locator('[data-action=sync]').click();
    await expect(q.locator('.settings-card').first()).toContainText('已同步');
    await q.locator('nav [data-tab=captures]').click();
    await expect(q.locator('.capture-card')).toContainText('Web 离线实验记录');
    await q.locator('nav [data-tab=knowledge]').click();
    await q.getByRole('button',{name:'文件',exact:true}).click();
    await q.locator('[data-action=file]').first().click();
    const download=q.waitForEvent('download');
    await q.getByRole('button',{name:'导出原件',exact:true}).click();
    const file=await download;expect(file.suggestedFilename()).toBe('实验资料.txt');
    const stream=await file.createReadStream();let content='';for await(const part of stream) content+=part;
    expect(content).toBe('cross device original bytes');
  } finally {await a.close();await b.close();}
});

test('browser extracts PDF text through its bundled worker without sending the original to a parser service',async({page})=>{
  const parts=['%PDF-1.4\n'];const offsets=[0];
  const text='BT /F1 18 Tf 50 700 Td (AI Bro PDF fixture) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 1 /Kids [3 0 R] >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${text.length} >>\nstream\n${text}\nendstream`];
  for(const [i,obj] of objects.entries()){offsets.push(Buffer.byteLength(parts.join('')));parts.push(`${i+1} 0 obj\n${obj}\nendobj\n`);}
  const xref=Buffer.byteLength(parts.join(''));parts.push(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  await page.goto('http://127.0.0.1:8900/');
  await page.getByRole('button',{name:'✎ 记个想法'}).click();
  await page.locator('#capture-form textarea').fill('PDF 本地读取测试');
  await page.locator('input[name=files]').setInputFiles({name:'fixture.pdf',mimeType:'application/pdf',buffer:Buffer.from(parts.join(''))});
  await page.getByRole('button',{name:'保存随记',exact:true}).click();
  await expect(page.locator('#sheet')).not.toBeVisible();
  await page.locator('nav [data-tab=knowledge]').click();
  await page.getByRole('button',{name:'文件',exact:true}).click();
  await page.locator('[data-action=file]').first().click();
  await expect(page.locator('#sheet .reader')).toContainText('AI Bro PDF fixture');
});
