"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const read = file => fs.readFileSync(file, "utf8");
const tick = async (count = 6) => {
  for (let i = 0; i < count; i++) await new Promise(resolve => setImmediate(resolve));
};

function popupHarness({deferredLoad = false} = {}) {
  class Element {
    constructor() {
      this.value = "";
      this.textContent = "";
      this.disabled = false;
      this.hidden = false;
      this.style = {};
      this.events = new Map();
      this.classList = {toggle() {}, add() {}, remove() {}};
    }
    addEventListener(name, listener) {
      const handlers = this.events.get(name) || [];
      handlers.push(listener);
      this.events.set(name, handlers);
    }
    setAttribute() {}
    fire(name) {
      return Promise.all((this.events.get(name) || []).map(fn => fn({type: name})));
    }
  }

  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  get("clearDraft").disabled = true;
  const windowEvents = new Map();
  const stored = new Map([["autoTypeDraft:17", "Saved draft"]]);
  const writes = [];
  const removals = [];
  let resolveDraftRead = null;
  const session = {
    get: key => deferredLoad ? new Promise(resolve => { resolveDraftRead = resolve; }) :
      Promise.resolve({[key]: stored.get(key)}),
    set: async data => {
      writes.push(data);
      for (const [key, value] of Object.entries(data)) stored.set(key, value);
    },
    remove: async key => {
      removals.push(key);
      stored.delete(key);
    }
  };
  const chrome = {
    runtime: {getManifest: () => ({permissions: []})},
    storage: {local: {get: async () => ({}), set: async () => {}}, session},
    tabs: {
      query: async () => [{id: 17, url: "https://docs.google.com/document/d/demo/edit"}],
      sendMessage: async () => ({ok: true, status: {state: "idle", index: 0, total: 0}})
    }
  };
  const document = {
    getElementById: get,
    querySelectorAll: () => []
  };
  const window = {
    addEventListener: (name, callback) => windowEvents.set(name, callback),
    close: () => { windowEvents.get("pagehide")?.(); windowEvents.get("unload")?.(); }
  };
  const context = {chrome, document, window, console, setTimeout, clearTimeout, setInterval, clearInterval, Array, Event};
  vm.runInNewContext(read("iframe/popup.js"), context, {filename: "popup.js"});
  return {
    get, stored, writes, removals,
    pagehide: () => { windowEvents.get("pagehide")(); windowEvents.get("unload")?.(); },
    resolveLoad: () => resolveDraftRead?.({"autoTypeDraft:17": stored.get("autoTypeDraft:17")}),
    canResolveLoad: () => Boolean(resolveDraftRead)
  };
}

test("closing during initial draft read never overwrites the saved text", async () => {
  const h = popupHarness({deferredLoad: true});
  await tick();
  assert.equal(h.canResolveLoad(), true);
  h.pagehide();
  h.resolveLoad();
  await tick();
  assert.equal(h.stored.get("autoTypeDraft:17"), "Saved draft");
  assert.equal(h.writes.length, 0);
});

test("closing without editing a restored draft never writes an empty text area", async () => {
  const h = popupHarness();
  await tick();
  assert.equal(h.get("text").value, "Saved draft");
  h.pagehide();
  await tick();
  assert.equal(h.stored.get("autoTypeDraft:17"), "Saved draft");
  assert.equal(h.writes.length, 0);
});

test("Clear draft empties the input and storage without pagehide resurrection", async () => {
  const h = popupHarness();
  await tick();
  assert.equal(h.get("clearDraft").disabled, false);
  h.get("text").value = "New text";
  await h.get("text").fire("input");
  await h.get("clearDraft").fire("click");
  assert.equal(h.get("text").value, "");
  assert.equal(h.stored.has("autoTypeDraft:17"), false);
  assert.equal(h.removals.length, 1);
  h.pagehide();
  await tick();
  assert.equal(h.stored.has("autoTypeDraft:17"), false);
});

test("both editions use the same popup and lifecycle code", () => {
  for (const file of ["popup.js", "popup.html", "popup.css", "content.js"]) {
    assert.equal(read("iframe/" + file), read("hybrid/" + file));
  }
});

test("keyboard lock cleanup failure does not permanently lock future sessions", async () => {
  const events = new Map();
  class SyntheticEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.detail = options.detail;
    }
  }
  const document = {
    addEventListener: (type, handler) => {
      const handlers = events.get(type) || [];
      handlers.push(handler);
      events.set(type, handlers);
    },
    removeEventListener: (type, handler, capture) => {
      if (capture === true && type === "keydown") throw new Error("Simulated cleanup failure");
      events.set(type, (events.get(type) || []).filter(fn => fn !== handler));
    },
    dispatchEvent: event => {
      if (event.type === "__auto_type_main_request_v3__") {
        const request = JSON.parse(event.detail);
        queueMicrotask(() => document.dispatchEvent(new SyntheticEvent("__auto_type_main_response_v3__", {
          detail: JSON.stringify({id: request.id, ok: true})
        })));
      }
      for (const fn of [...(events.get(event.type) || [])]) fn(event);
      return true;
    },
    querySelector: () => null
  };
  let messageListener;
  const chrome = {
    runtime: {
      getManifest: () => ({permissions: []}),
      onMessage: {addListener: fn => {messageListener = fn;}},
      sendMessage: async () => ({ok: true})
    }
  };
  const context = {
    chrome, document, window: {}, console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    performance, Event: SyntheticEvent, CustomEvent: SyntheticEvent
  };
  vm.runInNewContext(read("iframe/content.js"), context, {filename: "content.js"});
  function send(type, data = {}) {
    let answer;
    messageListener({type, ...data}, {}, response => {answer = response;});
    return answer;
  }
  const settings = {advancedMode: true, keyboardLock: true, showOverlay: false,
    startDelay: 0, mode: "iframe"};
  assert.equal(send("AT_PAGE_START", {text: "a", options: settings}).ok, true);
  for (let i = 0; i < 30 && send("AT_PAGE_STATUS").status.state !== "done"; i++) await tick(1);
  assert.equal(send("AT_PAGE_STATUS").status.state, "done");
  // A missing finalized flag would make this report "still cleaning up".
  assert.equal(send("AT_PAGE_START", {text: "b", options: settings}).ok, true);
  for (let i = 0; i < 30 && send("AT_PAGE_STATUS").status.state !== "done"; i++) await tick(1);
  assert.equal(send("AT_PAGE_STATUS").status.state, "done");
});


test("iframe typing survives a missing background message receiver", async () => {
  const events = new Map();
  class SyntheticEvent {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
  }
  const document = {
    addEventListener(type, handler) {
      events.set(type, [...(events.get(type) || []), handler]);
    },
    removeEventListener(type, handler) {
      events.set(type, (events.get(type) || []).filter(fn => fn !== handler));
    },
    dispatchEvent(event) {
      if (event.type === "__auto_type_main_request_v3__") {
        const request = JSON.parse(event.detail);
        queueMicrotask(() => document.dispatchEvent(new SyntheticEvent("__auto_type_main_response_v3__", {
          detail: JSON.stringify({id: request.id, ok: true})
        })));
      }
      for (const handler of [...(events.get(event.type) || [])]) handler(event);
      return true;
    },
    querySelector: () => null
  };
  let listener;
  const warnings = [];
  let backgroundCalls = 0;
  const chrome = {
    runtime: {
      getManifest: () => ({permissions: []}),
      onMessage: {addListener: fn => { listener = fn; }},
      async sendMessage() {
        backgroundCalls++;
        throw new Error("Could not establish connection. Receiving end does not exist.");
      }
    }
  };
  vm.runInNewContext(read("iframe/content.js"), {
    chrome, document, window: {},
    console: {...console, warn: (...args) => warnings.push(args)},
    setTimeout, clearTimeout, setInterval, clearInterval,
    performance, Event: SyntheticEvent, CustomEvent: SyntheticEvent
  }, {filename: "content.js"});
  const send = (type, data = {}) => {
    let result;
    listener({type, ...data}, {}, value => {result = value;});
    return result;
  };
  assert.equal(send("AT_PAGE_START", {
    text: "ab",
    options: {advancedMode: true, startDelay: 0, cpm: 1800, jitter: 0, mode: "iframe", showOverlay: false}
  }).ok, true);
  for (let i = 0; i < 70 && send("AT_PAGE_STATUS").status.state === "running"; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const status = send("AT_PAGE_STATUS").status;
  assert.equal(status.state, "done", status.error);
  assert.equal(status.index, 2);
  assert.equal(backgroundCalls, 1, "only first background wait attempted after failover");
  assert.equal(warnings.length, 1, "only one fallback warning per session");
});

test("popup injects MAIN-world bridge without requiring worker on Start", async () => {
  // Static guard for the critical path independent of background.js:
  const script = read("iframe/popup.js");
  assert.match(script, /await chrome\.scripting\.executeScript\(/);
  assert.match(script, /files: \["main-bridge\.js"\]/);
  assert.match(script, /world: "MAIN"/);
  assert.ok(script.indexOf('files: ["main-bridge.js"]') < script.indexOf('pageMessage("AT_PAGE_START"'));
});
