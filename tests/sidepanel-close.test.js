// 侧栏顶部的「关闭侧栏」按钮。用 jsdom 加载真实的 sidepanel.html + sidepanel.js，覆盖：
//  1) 按钮在顶栏里，和「打开完整界面」并排，带无障碍名称
//  2) Chrome 141+（有 chrome.sidePanel.close）：按当前窗口关闭侧栏，不调用 window.close()
//  3) 旧版 Chrome（没有 sidePanel.close）：退回 window.close()
//  4) sidePanel.close 抛错：也退回 window.close()，按钮不会「点了没反应」
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
let windowCloses = 0;
window.close = () => { windowCloses += 1; };

const store = {
  laterOnItems: [],
  laterOnProjects: [],
  laterOnActiveProject: "unfiled",
  laterOnSettings: {}
};

const changeListeners = [];
const panelCloses = [];
let closeImpl = async (options) => { panelCloses.push(options); };
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
  sidePanel: { close: (options) => closeImpl(options) },
  runtime: {
    getURL: (path) => `chrome-extension://lateron/${path}`,
    sendMessage: () => Promise.resolve({ ok: false }),
    onMessage: { addListener() {} }
  }
};

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? "  → " + extra : ""}`);
  if (!ok) failures += 1;
};
const tick = (ms = 20) => new Promise((resolve) => window.setTimeout(resolve, ms));
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));

window.eval(i18nSource);
window.eval(tabNavigationSource);
require("./helpers/item-mutation")(window);
window.eval(sidepanelSource);

(async () => {
  await tick(50);

  console.log("── 第 1 步：按钮位置 ──");
  const button = document.querySelector("#closePanel");
  check("顶栏里有关闭按钮", !!button && !!button.closest("header"));
  check("和「打开完整界面」并排在同一组", button?.parentElement === document.querySelector("#openLibrary")?.parentElement);
  check("带无障碍名称", /关闭侧栏|Close side panel/.test(button?.getAttribute("aria-label") || ""), button?.getAttribute("aria-label"));

  console.log("\n── 第 2 步：Chrome 141+ 用 sidePanel.close 按窗口关闭 ──");
  click(button);
  await tick(30);
  check("调用了 chrome.sidePanel.close", panelCloses.length === 1, JSON.stringify(panelCloses));
  check("带上了当前窗口 id", panelCloses[0]?.windowId === 7, JSON.stringify(panelCloses[0]));
  check("没有退回 window.close()", windowCloses === 0, `window.close ×${windowCloses}`);

  console.log("\n── 第 3 步：sidePanel.close 抛错时退回 window.close() ──");
  closeImpl = async () => { throw new Error("not supported"); };
  click(button);
  await tick(30);
  check("退回 window.close()", windowCloses === 1, `window.close ×${windowCloses}`);

  console.log("\n── 第 4 步：旧版 Chrome 没有 sidePanel.close ──");
  delete window.chrome.sidePanel;
  click(button);
  await tick(30);
  check("直接 window.close()", windowCloses === 2, `window.close ×${windowCloses}`);

  console.log("\n── 第 5 步：全程没有未捕获的错误 ──");
  check("没有 jsdom 报错", errors.length === 0, errors.slice(0, 3).join(" | "));

  console.log(`\n${failures === 0 ? "全部通过" : "存在失败"}：${failures === 0 ? "没有失败项" : failures + " 项失败"}`);
  process.exit(failures === 0 ? 0 : 1);
})();
