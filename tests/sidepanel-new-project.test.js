// 侧栏「全部」右边的 ＋ 按钮：新建项目。用 jsdom 加载真实的 sidepanel.html + sidepanel.js，覆盖：
//  1) 按钮在筛选行里、紧跟「全部」，且不是筛选按钮（点它不会改变未读/已读/全部的高亮）
//  2) 点击后弹出输入框，输入名字确认 → 通过后台 CREATE_PROJECT 建项目
//  3) 建好后侧栏直接切到新项目（项目栏高亮 + 记到 laterOnActiveProject）
//  4) 取消或留空 → 不发消息、不改当前项目
//  5) 后台返回失败 → 状态栏给出提示，按钮恢复可用
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(`${ROOT}/sidepanel.html`, "utf8");
const sidepanelSource = fs.readFileSync(`${ROOT}/sidepanel.js`, "utf8");
const tabNavigationSource = fs.readFileSync(`${ROOT}/tab-navigation.js`, "utf8");
const i18nSource = fs.readFileSync(`${ROOT}/i18n.js`, "utf8");

const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (error) => errors.push(String(error?.message || error)));
virtualConsole.on("error", (message) => errors.push(String(message)));

const dom = new JSDOM(html, {
  runScripts: "outside-only",
  pretendToBeVisual: true,
  url: "chrome-extension://lateron/sidepanel.html",
  virtualConsole
});
const { window } = dom;
const { document } = window;
window.scrollTo = () => {};

const now = Date.now();
const store = {
  laterOnItems: [
    { id: "a", title: "A", description: "da", image: "", favicon: "", source: "a.com", projectId: null, url: "https://a.com", savedAt: now, status: "unread" }
  ],
  laterOnProjects: [{ id: "p-work", name: "工作", createdAt: 1 }],
  laterOnActiveProject: "unfiled",
  laterOnSettings: {}
};

const changeListeners = [];
const messages = [];
let createReply = null;
window.chrome = {
  storage: {
    local: {
      get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const key of list) if (key in store) out[key] = store[key];
        return Promise.resolve(out);
      },
      set(patch) {
        const changes = {};
        for (const [key, value] of Object.entries(patch)) {
          changes[key] = { oldValue: store[key], newValue: value };
          store[key] = value;
        }
        window.setTimeout(() => changeListeners.forEach((fn) => fn(changes, "local")), 0);
        return Promise.resolve();
      }
    },
    onChanged: { addListener(fn) { changeListeners.push(fn); } }
  },
  tabs: {
    query: () => Promise.resolve([{ id: 1, windowId: 7, active: true, url: "https://current.com" }]),
    update: () => Promise.resolve({}),
    create: () => Promise.resolve({}),
    onActivated: { addListener() {} },
    onUpdated: { addListener() {} }
  },
  windows: { getCurrent: () => Promise.resolve({ id: 7 }) },
  runtime: {
    getURL: (path) => `chrome-extension://lateron/${path}`,
    sendMessage: async (message) => {
      messages.push(message);
      if (message?.type === "CREATE_PROJECT") {
        // 模拟后台 createProject：写库并回传新项目。
        const reply = createReply ? createReply(message) : null;
        if (reply) return reply;
        const project = { id: `p-${messages.length}`, name: message.name, createdAt: Date.now() };
        await window.chrome.storage.local.set({ laterOnProjects: [...store.laterOnProjects, project] });
        return { ok: true, project, existed: false };
      }
      return { ok: false };
    },
    onMessage: { addListener() {} }
  }
};

// 弹窗脚本按需加载：这里直接塞一个假的 LaterOnDialog，记录收到的配置并按剧本回答。
let promptScript = () => ({ ok: false, values: {} });
const prompts = [];
window.LaterOnDialog = {
  prompt: async (config) => { prompts.push(config); return promptScript(config); }
};

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? "  → " + extra : ""}`);
  if (!ok) failures += 1;
};
const tick = (ms = 20) => new Promise((resolve) => window.setTimeout(resolve, ms));
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
const activeProjectName = () => document.querySelector("#projectFilters .project-filter.active .project-name")?.textContent || "";

window.eval(i18nSource);
window.eval(tabNavigationSource);
require("./helpers/item-mutation")(window);
window.eval(sidepanelSource);

(async () => {
  await tick(50);

  console.log("── 第 1 步：按钮位置与性质 ──");
  const button = document.querySelector("#newProject");
  check("筛选行里有 ＋ 按钮", !!button);
  check("＋ 紧跟在「全部」右边", button?.previousElementSibling?.dataset.filter === "all");
  check("＋ 不是筛选按钮（不带 .filter）", !button?.classList.contains("filter"));
  check("＋ 有无障碍名称", /新建项目|New project/.test(button?.getAttribute("aria-label") || ""));
  const activeFilterBefore = document.querySelector(".filters .filter.active")?.dataset.filter;

  console.log("\n── 第 2 步：取消 / 留空不建项目 ──");
  promptScript = () => ({ ok: false, values: { name: "放弃" } });
  click(button);
  await tick(30);
  check("弹出了输入框", prompts.length === 1 && Array.isArray(prompts[0].fields) && prompts[0].fields[0]?.name === "name");
  check("取消后不发 CREATE_PROJECT", !messages.some((m) => m.type === "CREATE_PROJECT"));
  promptScript = () => ({ ok: true, values: { name: "   " } });
  click(button);
  await tick(30);
  check("名字留空也不发 CREATE_PROJECT", !messages.some((m) => m.type === "CREATE_PROJECT"));
  check("当前项目没变", store.laterOnActiveProject === "unfiled" && activeProjectName() !== "");
  check("阅读状态筛选的高亮没变", document.querySelector(".filters .filter.active")?.dataset.filter === activeFilterBefore);

  console.log("\n── 第 3 步：输入名字确认 → 建项目并切过去 ──");
  promptScript = () => ({ ok: true, values: { name: " 读书 " } });
  click(button);
  await tick(60);
  const created = messages.find((m) => m.type === "CREATE_PROJECT");
  check("通过后台 CREATE_PROJECT 建项目，名字已去掉首尾空格", created?.name === "读书", JSON.stringify(created));
  check("项目栏出现并高亮了新项目", activeProjectName() === "读书", `active=${activeProjectName()}`);
  check("当前项目记到 storage，供全屏界面与下次打开复用", store.laterOnProjects.some((p) => p.id === store.laterOnActiveProject && p.name === "读书"), store.laterOnActiveProject);
  check("状态栏提示已新建", /读书/.test(document.querySelector("#status")?.textContent || ""), document.querySelector("#status")?.textContent);
  check("按钮恢复可用", button.disabled === false);

  console.log("\n── 第 4 步：同名项目 → 直接切到已有的那个 ──");
  promptScript = () => ({ ok: true, values: { name: "工作" } });
  createReply = () => ({ ok: true, project: store.laterOnProjects.find((p) => p.name === "工作"), existed: true });
  click(button);
  await tick(60);
  check("切到了已有的「工作」", activeProjectName() === "工作" && store.laterOnActiveProject === "p-work", `active=${activeProjectName()}`);
  check("项目列表没有重复的「工作」", store.laterOnProjects.filter((p) => p.name === "工作").length === 1);

  console.log("\n── 第 5 步：后台失败 → 提示并恢复 ──");
  createReply = () => ({ ok: false, error: "项目名称不能为空" });
  promptScript = () => ({ ok: true, values: { name: "坏掉" } });
  click(button);
  await tick(60);
  check("失败时状态栏显示后台给的原因", /项目名称不能为空/.test(document.querySelector("#status")?.textContent || ""), document.querySelector("#status")?.textContent);
  check("失败后仍停在原项目", store.laterOnActiveProject === "p-work");
  check("按钮恢复可用", button.disabled === false);

  console.log("\n── 第 6 步：全程没有未捕获的错误 ──");
  check("没有 jsdom 报错", errors.length === 0, errors.slice(0, 3).join(" | "));

  console.log(`\n${failures === 0 ? "全部通过" : "存在失败"}：${failures === 0 ? "没有失败项" : failures + " 项失败"}`);
  process.exit(failures === 0 ? 0 : 1);
})();
