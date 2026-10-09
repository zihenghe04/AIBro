import { test, expect } from "@playwright/test";

const APP = "http://127.0.0.1:8899";
test.use({ viewport: { width: 320, height: 720 }, locale: "zh-CN", timezoneId: "Asia/Shanghai", serviceWorkers: "block" });

async function fixture(page) {
  const errors = [], external = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (new URL(request.url()).origin !== APP) external.push(request.url()); });
  await page.route("**/__home_planner_fixture", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'"><title>Isolated planner</title></head><body><main style="padding:22px"><form id="other-form"><textarea id="draft" aria-label="未发送草稿">不要覆盖输入内容</textarea><div id="owned-planner"></div></form></main></body></html>` }));
  await page.route("https://**/*", route => route.abort());
  await page.goto(APP + "/__home_planner_fixture");
  await page.evaluate(async () => {
    await import("/src/style.css");
    const { mountHomePlanner } = await import("/src/ui/home-planner.js");
    window.mountHomePlanner = mountHomePlanner;
    window.calls = { events: [], tasks: [], newEvents: [], newTasks: 0, imports: 0, courses: 0, submits: 0 };
    document.querySelector("#other-form").addEventListener("submit", event => { event.preventDefault(); calls.submits++; });
    window.planner = await mountHomePlanner(document.querySelector("#owned-planner"), {
      today: "2030-01-07", selectedDay: "2030-01-07", mode: "agenda", showCompleted: false,
      projects: [{ id: "project-one", name: "课程设计" }],
      events: [{ id: "event-one", title: "讨论论文里的实验方法", location: "研讨室", projectId: "project-one", start: +new Date("2030-01-07T09:00:00+08:00"), end: +new Date("2030-01-07T10:00:00+08:00") }],
      tasks: [{ id: "independent", title: "整理这周的读书摘记", description: "列出待查证的问题，不用着急定下截止时间。", status: "todo" },
        { id: "overdue", title: "补充课程实验的对照组", projectId: "project-one", dueAt: "2030-01-06", status: "doing" },
        { id: "long", title: "一个非常长的需要保留全部信息的任务名称".repeat(4), description: "正文的详细说明".repeat(15), dueAt: "2030-01-08", status: "todo" },
        { id: "done", title: "已经交付的汇报", status: "done", completedAt: 123 }],
      onMode: mode => planner.update({ mode }), onDay: selectedDay => planner.update({ selectedDay }), onShowCompleted: showCompleted => planner.update({ showCompleted }),
      onEvent: event => calls.events.push(event.id), onTask: task => calls.tasks.push(task.id), onNewEvent: day => calls.newEvents.push(day), onNewTask: () => calls.newTasks++, onImport: () => calls.imports++, onCourses: () => calls.courses++,
    });
    await document.fonts.ready;
  });
  return { errors, external };
}

test("owned offline planner has 44px controls, selected-week navigation and direct event/task creation callbacks", async ({ page }, info) => {
  const evidence = await fixture(page);
  await expect(page.locator('[data-halaska-root="MobileHomePlanner"]')).toBeVisible();
  await expect(page.locator('[aria-current="date"]')).toHaveAttribute("data-planner-day", "2030-01-07");
  await page.locator('[data-planner-id="event-one"]').click();
  await page.getByRole("button", { name: "新建日程", exact: true }).click();
  await page.getByRole("button", { name: "下一周", exact: true }).click();
  await expect(page.locator('[data-planner-day="2030-01-14"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[aria-current="date"]')).toHaveCount(0);
  await page.getByRole("button", { name: "回到今天", exact: true }).click();
  await page.getByLabel("选择日期", { exact: true }).fill("2030-12-01");
  await expect(page.locator('[data-planner-day="2030-12-01"]')).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "新建日程", exact: true }).click();
  await page.getByRole("button", { name: "导入日历 .ics", exact: true }).click();
  await page.getByRole("button", { name: "打开课程", exact: true }).click();
  await page.screenshot({ path: info.outputPath("planner-agenda-light-320.png") });
  const sizes = await page.locator("#owned-planner button").evaluateAll(elements => elements.map(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })));
  expect(sizes.every(size => size.width >= 44 && size.height >= 44)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  expect(await page.evaluate(() => ({ events: calls.events, newEvents: calls.newEvents, imports: calls.imports, courses: calls.courses, submits: calls.submits }))).toEqual({ events: ["event-one"], newEvents: ["2030-01-07", "2030-12-01"], imports: 1, courses: 1, submits: 0 });
  expect(evidence.errors).toEqual([]); expect(evidence.external).toEqual([]);
});

test("pending tasks include independent undated work, completed view and dark reduced-motion layout retain draft", async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  const evidence = await fixture(page);
  await page.getByRole("button", { name: "待办 3", exact: true }).click();
  await expect(page.getByRole("region", { name: "逾期", exact: true })).toContainText("补充课程实验的对照组");
  await expect(page.getByRole("region", { name: "未排期", exact: true })).toContainText("整理这周的读书摘记");
  await page.locator('[data-planner-id="independent"]').click();
  await page.getByRole("button", { name: "新建待办", exact: true }).click();
  await page.locator("#draft").focus();
  await page.evaluate(() => planner.update({ projects: [{ id: "project-one", name: "课程设计 · 已同步" }] }));
  await expect(page.locator("#draft")).toBeFocused();
  await expect(page.locator("#draft")).toHaveValue("不要覆盖输入内容");
  await page.screenshot({ path: info.outputPath("planner-tasks-dark-320.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  expect(await page.locator('[data-planner-id="independent"]').evaluate(element => getComputedStyle(element).transitionDuration)).toBe("0s");
  await page.getByRole("button", { name: "查看已完成待办", exact: true }).click();
  await expect(page.locator('[data-planner-id="done"]')).toBeVisible();
  await expect(page.locator('[data-planner-id="independent"]')).toHaveCount(0);
  await page.locator('[data-planner-id="done"]').click();
  await page.getByRole("button", { name: "查看未完成待办", exact: true }).click();
  await page.evaluate(() => planner.update({ onNewTask: async () => { throw Error("合成编辑器错误"); } }));
  await page.getByRole("button", { name: "新建待办", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("合成编辑器错误");
  expect(await page.evaluate(() => ({ tasks: calls.tasks, newTasks: calls.newTasks, submits: calls.submits }))).toEqual({ tasks: ["independent", "done"], newTasks: 1, submits: 0 });
  const lifecycle = await page.evaluate(async () => {
    let refused = false;
    const filled = document.createElement("div"); filled.textContent = "保留"; document.body.append(filled);
    try { await mountHomePlanner(filled, {}); } catch { refused = true; }
    planner.unmount();
    return { refused, existing: filled.textContent, closed: !document.querySelector("#owned-planner").childNodes.length, postClose: planner.update({ mode: "agenda" }) };
  });
  expect(lifecycle).toEqual({ refused: true, existing: "保留", closed: true, postClose: false });
  expect(evidence.errors).toEqual([]); expect(evidence.external).toEqual([]);
});

test("selected mode's visual state changes with its content without retaining the previous highlight", async ({ page }, info) => {
  await page.clock.setFixedTime(new Date("2030-01-07T12:00:00+08:00"));
  const evidence = await fixture(page);
  const agenda = page.locator(".mobile-planner__modes button").filter({ hasText: "日程" });
  const tasks = page.locator(".mobile-planner__modes button").filter({ hasText: "待办" });
  await expect(agenda).toHaveAttribute("aria-pressed", "true");
  await tasks.click();
  await expect(tasks).toHaveAttribute("aria-pressed", "true");
  await expect(agenda).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".mobile-planner__tasks")).toBeVisible();
  const colors = await page.locator(".mobile-planner__modes button").evaluateAll(buttons => buttons.map(button => ({ name: button.textContent, selected: button.getAttribute("aria-pressed"), background: getComputedStyle(button).backgroundColor, transition: getComputedStyle(button).transitionProperty })));
  expect(colors).toEqual([
    { name: "日程", selected: "false", background: "rgba(0, 0, 0, 0)", transition: "transform, box-shadow, filter" },
    { name: "待办3", selected: "true", background: "rgb(255, 255, 255)", transition: "transform, box-shadow, filter" },
  ]);
  await page.screenshot({ path: info.outputPath("planner-selected-tasks-light-320.png") });
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await tasks.evaluate(button => getComputedStyle(button).transitionDuration)).toBe("0s");
  expect(evidence.errors).toEqual([]); expect(evidence.external).toEqual([]);
});
