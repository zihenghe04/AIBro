import { test, expect } from "@playwright/test";
test("school login shows actionable failure without leaking response secrets, and supports a credential-free check", async ({ page }) => {
  let loginCalls = 0;
  await page.route("**/api/ucas", async (route) => {
    const login = route.request().postDataJSON().url.includes("user/login.action");
    if (login) loginCalls++;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(login
        ? { STATUS: 0, result: { id: "private-user", sessionId: "private-session" } }
        : { STATUS: 0, timestamp: Date.now() }),
    });
  });
  await page.goto("http://127.0.0.1:8899");
  await page.getByRole("button", { name: "⚙", exact: true }).click();
  await page.locator('[data-action="ucas"]').click();
  await page.locator(".school-login summary").click();
  await page.locator('#ucas-form [name="username"]').fill("test@example.test");
  await page.locator('#ucas-form [name="password"]').fill("synthetic-password");
  await page.getByRole("button", { name: "连接账号", exact: true }).click();
  await expect(page.locator(".sheet-status")).toContainText("studentNo（LOGIN_INCOMPLETE）");
  await expect(page.locator(".sheet-status")).not.toContainText("private-session");
  await page.getByRole("button", { name: "检查学校连接" }).click();
  await expect(page.locator("#sheet")).toContainText("学校校时服务连接正常");
  expect(loginCalls).toBe(1);
});
test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
test("phone capture, attachment, project, task and restart flow", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:8899");
  await page.getByRole("button", { name: "✎ 记个想法" }).click();
  await page
    .locator("#capture-form textarea")
    .fill("短事件容易被均匀采样漏掉。下次对比事件密度采样。");
  await page.locator("input[name=files]").setInputFiles({
    name: "实验.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# 实验\n保留失败样例"),
  });
  await page.getByRole("button", { name: "保存随记", exact: true }).click();
  await expect(page.locator("#sheet")).not.toBeVisible();
  await page.reload();
  await page.locator("nav button[data-tab=captures]").click();
  await expect(page.locator(".capture-card")).toContainText("短事件");
  await page.locator("nav button[data-tab=knowledge]").click();
  await page.getByRole("button", { name: "＋ 新建项目" }).click();
  await page.locator("[name=name]").fill("手机研究项目");
  await page.getByRole("button", { name: "创建项目" }).click();
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await page.locator("[data-action=project]").click();
  await page.getByRole("button", { name: "＋ 添加" }).click();
  await page.locator("#task-form [name=title]").fill("比较两组采样");
  await page.locator("[name=due]").fill("2026-09-18T08:30");
  await page.getByRole("button", { name: "保存任务" }).click();
  await page.locator("[data-action=project]").click();
  await page.locator("[data-action=task]").click();
  await expect(page.locator("[name=due]")).toHaveValue("2026-09-18T08:30");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator("nav button[data-tab=today]").click();
  await page.locator("#day-picker").fill("2026-09-18");
  await expect(page.locator(".event-row")).toContainText("比较两组采样");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  expect(errors).toEqual([]);
  await page.screenshot({
    path: "test-results/phone-today.png",
    fullPage: true,
  });
});
test("demo, dark mode, draft preservation and no horizontal overflow", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("http://127.0.0.1:8899/?demo=1");
  await expect(page.locator("[data-action=project]").first()).toBeVisible();
  await page.getByRole("button", { name: "✎ 记个想法" }).click();
  await page.locator("#capture-form textarea").fill("还没写完");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "✎ 记个想法" }).click();
  await expect(page.locator("#capture-form textarea")).toHaveValue("还没写完");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: "test-results/phone-dark.png",
    fullPage: true,
  });
});
test("AI rewrite renders diff and only changes the note after acceptance", async ({
  page,
}) => {
  await page.route("https://model.example/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        choices: [
          {
            message: {
              content: "# 整理后的笔记\n保留原始事实，补充实验步骤。",
            },
          },
        ],
      }),
    }),
  );
  await page.goto("http://127.0.0.1:8899");
  await page.locator("header [data-tab=settings]").click();
  await page
    .locator("#model-form [name=base]")
    .fill("https://model.example/v1");
  await page.locator("[name=model]").fill("fixture-model");
  await page.locator("[name=key]").fill("fixture-not-a-real-key");
  await page.getByRole("button", { name: "保存模型连接" }).click();
  await page.locator("nav [data-tab=knowledge]").click();
  await page.getByRole("button", { name: "＋ 新建笔记" }).click();
  await page.locator("#note-form [name=title]").fill("实验笔记");
  await page.locator("#note-form textarea").fill("保留原始事实。");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page.getByRole("button", { name: "AI 改写草稿" }).click();
  await page.getByRole("button", { name: "生成草稿", exact: true }).click();
  await expect(page.locator(".diff")).toContainText("补充实验步骤");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator("[data-action=note]").first().click();
  await expect(page.locator("article.reader")).toHaveText("保留原始事实。");
  await page.getByRole("button", { name: "审阅 AI 草稿" }).click();
  await page.getByRole("button", { name: "采纳修改", exact: true }).click();
  await expect(page.locator("article.reader")).toContainText("补充实验步骤");
});
test("source edits survive preview switching and restart; modal errors are visible", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:8899");
  await page.locator("nav [data-tab=knowledge]").click();
  await page.getByRole("button", { name: "＋ 新建笔记" }).click();
  await page.locator("#note-form textarea").fill("尚未保存的正文");
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await expect(page.locator("article.reader")).toHaveText("尚未保存的正文");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.reload();
  await page.locator("nav [data-tab=knowledge]").click();
  await page.locator("[data-action=note]").first().click();
  await page.getByRole("button", { name: "源码", exact: true }).click();
  await expect(page.locator("#note-form textarea")).toHaveValue(
    "尚未保存的正文",
  );
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator("nav [data-tab=today]").click();
  await page.getByRole("button", { name: "国科大课程 ›" }).click();
  await page.getByRole("button", { name: "刷新今日课程" }).click();
  await expect(
    page
      .locator("#sheet [role=status]")
      .filter({ hasText: "请先连接学校账号" }),
  ).toBeVisible();
});

test("school login, current course, rolling QR and confirmed attendance", async ({
  page,
}) => {
  const now = new Date("2026-09-16T08:30:00+08:00");
  await page.clock.install({ time: now });
  let signs = 0;
  await page.route("**/api/ucas", (route) => {
    let value = { STATUS: 0 };
    const url = route.request().postDataJSON().url;
    if (url.includes("login.action"))
      value.result = {
        id: "1",
        studentNo: "fixture-student",
        sessionId: "fixture-school-session",
      };
    if (url.includes("get_stu_course_sched.action"))
      value.result = [
        {
          id: "1234567",
          courseName: "科研方法课",
          classBeginTime: "08:30",
          classEndTime: "10:00",
          teacherName: "测试教师",
          signStatus: signs ? "1" : "0",
        },
      ];
    if (url.includes("get_timestamp")) value.timestamp = now.getTime();
    if (url.includes("stu_scan_sign")) {
      signs++;
      value.result = { stuSignStatus: "1" };
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "*",
      },
      body: JSON.stringify(value),
    });
  });
  await page.goto("http://127.0.0.1:8899");
  await page.getByRole("button", { name: "国科大课程 ›" }).click();
  await page.getByText("连接 / 更换学校账号").click();
  await page.locator("#ucas-form [name=username]").fill("fixture-student");
  await page.locator("#ucas-form [name=password]").fill("fixture-password");
  await page.locator("#ucas-form button").click();
  await expect(page.locator(".school-overview")).toContainText("科研方法课");
  await page.getByRole("button", { name: "动态签到码", exact: true }).click();
  await expect(page.locator("#qr-image img")).toBeVisible();
  await page.clock.fastForward(6000);
  await expect(page.locator("#qr-image img")).toBeVisible();
  await page.getByRole("button", { name: "返回课程" }).click();
  await expect(page.locator("#qr-image")).toHaveCount(0);
  await page.getByRole("button", { name: "到课签到" }).click();
  await expect(page.locator(".school-course")).toContainText("学校显示已签到");
  expect(signs).toBe(1);
  await expect(page.locator("#sheet")).not.toContainText(
    "fixture-school-session",
  );
  await page.screenshot({
    path: "test-results/phone-school.png",
    fullPage: true,
  });
});

test("school connection opt-in recovers an expired session and logout removes access", async ({
  page,
}) => {
  let logins = 0,
    expired = false;
  await page.route("**/api/ucas", (route) => {
    const url = route.request().postDataJSON().url;
    let body;
    if (url.includes("login.action")) {
      logins++;
      body = {
        STATUS: 0,
        result: {
          id: "1",
          studentNo: "fixture-student",
          sessionId: "fixture-session-" + logins,
        },
      };
    } else if (expired && logins === 1) {
      body = { STATUS: 1, ERRMSG: "会话已过期，请重新登录" };
    } else {
      body = {
        STATUS: 0,
        result: [
          {
            id: "1234567",
            courseName: "会话恢复测试课",
            classBeginTime: "08:30",
            classEndTime: "10:00",
          },
        ],
      };
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.goto("http://127.0.0.1:8899");
  await page.getByRole("button", { name: "国科大课程 ›" }).click();
  await page.getByText("连接 / 更换学校账号").click();
  await expect(page.locator("#ucas-form [name=remember]")).not.toBeChecked();
  await page.locator("#ucas-form [name=username]").fill("fixture-student");
  await page.locator("#ucas-form [name=password]").fill("synthetic-password");
  await page.locator("#ucas-form [name=remember]").check();
  await page.locator("#ucas-form button").click();
  await expect(page.locator(".school-course")).toContainText("会话恢复测试课");
  expired = true;
  await page.getByRole("button", { name: "刷新今日课程" }).click();
  await expect(page.locator("#sheet [role=status]")).toContainText(
    "已从学校更新",
  );
  expect(logins).toBe(2);
  await expect(page.locator("#sheet")).not.toContainText("fixture-session");
  await page.getByRole("button", { name: "退出学校账号" }).click();
  await expect(page.locator(".school-course")).toHaveCount(0);
  await page.getByRole("button", { name: "刷新今日课程" }).click();
  await expect(
    page
      .locator("#sheet [role=status]")
      .filter({ hasText: "请先连接学校账号" }),
  ).toBeVisible();
  expect(logins).toBe(2);
});

test("a synced Mac recurring agenda note appears on its next date and keeps its rule after editing", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:8899");
  await page.evaluate(async () => {
    const { Store, IndexedAdapter } = await import("/src/store.js");
    const { agendaNote } = await import("/src/agenda.js");
    const store = await new Store(new IndexedAdapter("aibro-mobile-v1")).load();
    await store.put(
      "notes",
      agendaNote({
        title: "Mac 每周组会",
        start: Date.parse("2026-09-14T08:30:00+08:00"),
        end: Date.parse("2026-09-14T09:30:00+08:00"),
        timeZone: "Asia/Shanghai",
        location: "会议室",
        recurrence: {
          frequency: "weekly",
          interval: 1,
          weekdays: [2],
          count: 4,
          until: null,
        },
        excluded: [],
        completed: [],
        reminderMinutes: 15,
      }),
    );
  });
  await page.reload();
  await page.locator("#day-picker").fill("2026-09-21");
  await expect(page.locator(".event-row")).toContainText("Mac 每周组会");
  await page.locator(".event-row").click();
  await page.locator("#event-form [name=title]").fill("手机补充后的组会");
  await page.locator("#event-form button[type=submit]").click();
  await expect(page.locator("#sheet")).not.toBeVisible();
  await page.reload();
  await page.locator("#day-picker").fill("2026-09-28");
  await expect(page.locator(".event-row")).toContainText("手机补充后的组会");
});
