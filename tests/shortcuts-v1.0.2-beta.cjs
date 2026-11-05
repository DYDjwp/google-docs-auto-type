"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const read = name => fs.readFileSync(name, "utf8");
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
};

function shortcutHarness(edition = "iframe") {
  const tabs = [
    {id: 11, url: "https://docs.google.com/document/d/one/edit"},
    {id: 12, url: "https://docs.google.com/document/d/two/edit"},
    {id: 99, url: "https://example.com/"}
  ];
  let focused = 11;
  const states = new Map([[11, "running"], [12, "idle"]]);
  const sent = [];
  const warnings = [];
  let commandListener;
  const chrome = {
    runtime: {
      getManifest: () => ({permissions: edition === "hybrid" ? ["debugger"] : []}),
      onMessage: {addListener() {}}
    },
    tabs: {
      query: async filter => filter.url
        ? tabs.filter(tab => tab.url.startsWith("https://docs.google.com/document/"))
        : filter.active ? tabs.filter(tab => tab.id === focused) : tabs,
      sendMessage: async (tabId, message) => {
        if (message.type === "AT_PAGE_STATUS")
          return {ok: true, status: {state: states.get(tabId) || "idle"}};
        sent.push({tabId, type: message.type});
        if (message.type === "AT_PAGE_TOGGLE_PAUSE") {
          const previous = states.get(tabId);
          states.set(tabId, previous === "running" ? "paused" : previous === "paused" ? "running" : previous);
        } else if (message.type === "AT_PAGE_STOP") {
          states.set(tabId, "stopped");
        }
        return {ok: true, status: {state: states.get(tabId)}};
      },
      onRemoved: {addListener() {}},
      onUpdated: {addListener() {}}
    },
    commands: {
      onCommand: {addListener: fn => { commandListener = fn; }}
    },
    debugger: {onDetach: {addListener() {}}}
  };
  const consoleStub = {log() {}, warn: (...args) => warnings.push(args)};
  vm.runInNewContext(read(edition + "/background.js"), {chrome, console: consoleStub, setTimeout}, {
    filename: edition + "/background.js"
  });
  return {
    states, sent, warnings,
    setFocused: id => {focused = id;},
    async fire(command, hint) {
      assert.equal(typeof commandListener, "function", "command listener must exist");
      commandListener(command, hint);
      await flush();
    }
  };
}

test("both editions register identical beta shortcut commands", () => {
  const iframe = JSON.parse(read("iframe/manifest.json"));
  const hybrid = JSON.parse(read("hybrid/manifest.json"));
  for (const manifest of [iframe, hybrid]) {
    assert.equal(manifest.version, "1.0.2");
    assert.equal(manifest.version_name, "1.0.2-beta");
    assert.equal(manifest.commands["auto-type-toggle-pause"].suggested_key.default, "Alt+Shift+P");
    assert.equal(manifest.commands["auto-type-cancel"].suggested_key.default, "Alt+Shift+X");
  }
  assert.equal(iframe.permissions.includes("debugger"), false);
  assert.equal(hybrid.permissions.includes("debugger"), true);
  for (const file of ["background.js", "content.js", "popup.js", "popup.html", "popup.css"]) {
    assert.equal(read("iframe/" + file), read("hybrid/" + file), file);
  }
});

for (const edition of ["iframe", "hybrid"]) {
  test(edition + ": pause, resume, and cancel shortcut commands target the active task", async () => {
    const h = shortcutHarness(edition);
    await h.fire("auto-type-toggle-pause", {id: 11});
    assert.equal(h.states.get(11), "paused");
    await h.fire("auto-type-toggle-pause", {id: 11});
    assert.equal(h.states.get(11), "running");
    await h.fire("auto-type-cancel", {id: 11});
    assert.equal(h.states.get(11), "stopped");
    assert.deepEqual(h.sent.map(item => item.type),
      ["AT_PAGE_TOGGLE_PAUSE", "AT_PAGE_TOGGLE_PAUSE", "AT_PAGE_STOP"]);
  });

  test(edition + ": one background task can be paused from another tab", async () => {
    const h = shortcutHarness(edition);
    h.setFocused(99);
    await h.fire("auto-type-toggle-pause");
    assert.deepEqual(h.sent.map(item => item.tabId), [11]);
    assert.equal(h.states.get(11), "paused");
  });

  test(edition + ": focus wins with multiple running Docs, ambiguous offscreen tasks are ignored", async () => {
    const h = shortcutHarness(edition);
    h.states.set(12, "running");
    h.setFocused(12);
    await h.fire("auto-type-toggle-pause");
    assert.equal(h.states.get(11), "running");
    assert.equal(h.states.get(12), "paused");
    h.setFocused(99);
    await h.fire("auto-type-cancel");
    assert.equal(h.sent.length, 1, "must not guess which background task to cancel");
    assert.equal(h.warnings.length, 1);
  });

  test(edition + ": no active tasks or unknown commands do nothing", async () => {
    const h = shortcutHarness(edition);
    h.states.set(11, "done");
    await h.fire("auto-type-cancel");
    await h.fire("unknown-command");
    assert.equal(h.sent.length, 0);
  });
}

test("content script pause toggle is atomic and cancel stops current task", async () => {
  let onMessage;
  const listeners = new Map();
  class FakeEvent {
    constructor(type, props = {}) {this.type = type; this.detail = props.detail;}
  }
  const document = {
    addEventListener(type, handler) {
      listeners.set(type, [...(listeners.get(type) || []), handler]);
    },
    removeEventListener(type, handler) {
      listeners.set(type, (listeners.get(type) || []).filter(fn => fn !== handler));
    },
    dispatchEvent(event) {
      if (event.type === "__auto_type_main_request_v3__") {
        const request = JSON.parse(event.detail);
        queueMicrotask(() => document.dispatchEvent(new FakeEvent("__auto_type_main_response_v3__", {
          detail: JSON.stringify({id: request.id, ok: true})
        })));
      }
      for (const handler of [...(listeners.get(event.type) || [])]) handler(event);
    },
    querySelector: () => null
  };
  const chrome = {runtime: {
    getManifest: () => ({permissions: []}),
    onMessage: {addListener: fn => {onMessage = fn;}},
    sendMessage: async () => ({ok: true})
  }};
  vm.runInNewContext(read("iframe/content.js"), {
    chrome, document, window: {}, console,
    setTimeout, clearTimeout, setInterval, clearInterval, performance,
    Event: FakeEvent, CustomEvent: FakeEvent
  });
  const send = (type, data = {}) => {
    let value;
    onMessage({type, ...data}, {}, response => {value = response;});
    return value;
  };
  assert.equal(send("AT_PAGE_TOGGLE_PAUSE").status.state, "idle");
  assert.equal(send("AT_PAGE_START", {
    text: "abc", options: {mode: "iframe", advancedMode: true, startDelay: 0,
      showOverlay: false}
  }).ok, true);
  assert.equal(send("AT_PAGE_TOGGLE_PAUSE").status.state, "paused");
  assert.equal(send("AT_PAGE_TOGGLE_PAUSE").status.state, "running");
  assert.equal(send("AT_PAGE_STOP").status.state, "stopped");
  assert.equal(send("AT_PAGE_TOGGLE_PAUSE").status.state, "stopped");
  await flush();
});

test("popup includes shortcut hint and custom mapping discovery", () => {
  assert.match(read("iframe/popup.html"), /id="shortcutHelp"/);
  assert.match(read("iframe/popup.js"), /chrome\.commands\.getAll\(\)/);
  assert.match(read("iframe/popup.html"), /chrome:\/\/extensions\/shortcuts/);
});
