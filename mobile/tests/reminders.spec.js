import {test,expect} from '@playwright/test';
test('conversation reminder is editable and survives a page reload without model credentials',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:8899/');
 await page.locator('nav [data-tab="chat"]').click();
 await page.locator('[data-action="new-chat"]').click();
 await page.locator('#chat-text').fill('明天晚上8点提醒我买熨斗，洗衣液，护发素，袜子');
 await page.locator('#chat-form button[type=submit]').click();
 await expect(page.locator('.messages')).toContainText('已保存「买熨斗，洗衣液，护发素，袜子」');
 await expect(page.locator('.messages')).toContainText('开启本机通知');
 await page.reload();
 await page.locator('nav [data-tab="chat"]').click();
 await expect(page.locator('main')).toContainText('明天晚上8点');
 expect(errors).toEqual([]);
});
