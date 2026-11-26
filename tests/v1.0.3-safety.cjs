"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const read = file => fs.readFileSync(file, "utf8");
const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve));
};

function typingHarness({pauseAtTypo = true, verifiedCorrection = false} = {}) {
  const watchers = new Map();
  const buffer = {text: "HELLO", caret: 5};
  const inserted = [];
  const backspaces = [];
  let now = 0;
  let blockedWait = null;
  let listener;
  let shouldBlock = pauseAtTypo;
  class FakeEvent {
    constructor(type, props = {}) {this.type = type; this.detail = props.detail;}
  }
  const document = {
    addEventListener(type, fn) {
      watchers.set(type, [...(watchers.get(type) || []), fn]);
    },
    removeEventListener(type, fn) {
      watchers.set(type, (watchers.get(type) || []).filter(cb => cb !== fn));
    },
    querySelector: () => null,
    dispatchEvent(event) {
      if (event.type === "__auto_type_main_request_v3__") {
        const payload = JSON.parse(event.detail);
        if (payload.action === "type") {
          buffer.text = buffer.text.slice(0, buffer.caret) + payload.char + buffer.text.slice(buffer.caret);
          buffer.caret += payload.char.length;
          inserted.push(payload.char);
        }
        if (payload.action === "backspace") {
          backspaces.push(buffer.caret);
          if (buffer.caret > 0) {
            buffer.text = buffer.text.slice(0, buffer.caret - 1) + buffer.text.slice(buffer.caret);
            buffer.caret--;
          }
        }
        queueMicrotask(() => document.dispatchEvent(new FakeEvent("__auto_type_main_response_v3__", {
          detail: JSON.stringify({id: payload.id, ok: true, verifiedCorrection})
        })));
      }
      for (const fn of [...(watchers.get(event.type) || [])]) fn(event);
      return true;
    }
  };
  const chrome = {runtime: {
    getManifest: () => ({permissions: []}),
    onMessage: {addListener: cb => {listener = cb;}},
    sendMessage: async message => {
      if (message.type !== "AT_BG_WAIT") return {ok: true};
      if (shouldBlock) {
        shouldBlock = false;
        return new Promise(resolve => {
          blockedWait = () => {now += message.ms; resolve({ok: true});};
        });
      }
      now += message.ms;
      return {ok: true};
    }
  }};
  const fakeMath = Object.create(Math);
  fakeMath.random = () => 0; // Deterministically triggers a corrected typo.
  const logs = [];
  vm.runInNewContext(read("iframe/content.js"), {
    chrome, document, window: {},
    performance: {now: () => now}, Math: fakeMath,
    console: {...console, warn: (...args) => logs.push(args)},
    setTimeout, clearTimeout, setInterval, clearInterval,
    Event: FakeEvent, CustomEvent: FakeEvent
  }, {filename: "iframe/content.js"});
  const send = (type, data = {}) => {
    let reply;
    listener({type, ...data}, {}, value => {reply = value;});
    return reply;
  };
  const options = {advancedMode: true, mode: "iframe", fixTypo: true, fixChance: 35,
    fixPauseMs: 400, startDelay: 0, showOverlay: false,
    cpm: 1800, jitter: 0, rest: false};
  return {
    send, options, buffer, inserted, backspaces, logs,
    get blocked() {return blockedWait !== null;},
    release() {assert.ok(blockedWait); const resolve = blockedWait; blockedWait = null; resolve();},
    async waitForTemp() {
      for (let i = 0; i < 25 && !blockedWait; i++) await flush(1);
      assert.equal(buffer.text, "HELLOa");
      assert.ok(blockedWait, "must be waiting between characters");
    },
    fireTrusted(type) {
      document.dispatchEvent({type, isTrusted: true});
    }
  };
}

test("stop after first character never deletes original text or advances unsent progress",async()=>{
  const h=typingHarness();
  h.send("AT_PAGE_START",{text:"ab",options:h.options});
  await h.waitForTemp();
  h.buffer.caret=0;
  h.send("AT_PAGE_STOP");
  h.release();
  await flush();
  assert.equal(h.buffer.text,"HELLOa");
  assert.deepEqual(h.backspaces,[]);
  assert.equal(h.send("AT_PAGE_STATUS").status.index,1);
});

test("mouse interaction pauses without destructive correction",async()=>{
  const h=typingHarness();
  h.send("AT_PAGE_START",{text:"ab",options:h.options});
  await h.waitForTemp();
  h.fireTrusted("pointerdown");
  assert.equal(h.send("AT_PAGE_STATUS").status.state,"paused");
  h.send("AT_PAGE_STOP");h.release();await flush();
  assert.equal(h.buffer.text,"HELLOa");
  assert.deepEqual(h.backspaces,[]);
});

test("even a claimed verification capability cannot enable removed correction path",async()=>{
  const h=typingHarness({pauseAtTypo:false,verifiedCorrection:true});
  h.send("AT_PAGE_START",{text:"a",options:h.options});
  await flush();
  assert.equal(h.buffer.text,"HELLOa");
  assert.deepEqual(h.backspaces,[]);
  assert.equal(h.send("AT_PAGE_STATUS").status.index,1);
  assert.equal(h.send("AT_PAGE_STATUS").status.state,"done");
});

function popupHarness({failAlways = false} = {}) {
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
    addEventListener(name, cb) {
      this.events.set(name, [...(this.events.get(name) || []), cb]);
    }
    setAttribute() {}
    fire(name) {return Promise.all((this.events.get(name) || []).map(fn => fn({type: name}))); }
  }
  const elements = new Map();
  const get = key => {
    if (!elements.has(key)) elements.set(key, new Element());
    return elements.get(key);
  };
  const storage = new Map([
    ["autoTypeDraft:17:test", "Previous draft"],
    ["autoTypeDraft:99", "Orphaned draft"]
  ]);
  const calls = {set: 0, remove: [], start: 0, close: 0};
  const windowEvents = new Map();
  let closed = false;
  const chrome = {
    runtime: {getManifest: () => ({permissions: []})},
    commands: {getAll: async () => []},
    tabs: {
      query: async opts => opts.active
        ? [{id:17,url:"https://docs.google.com/document/d/test/edit"}]
        : [{id:17},{id:18}],
      sendMessage: async (id, payload) => {
        if (payload.type === "AT_PAGE_START") calls.start++;
        return {ok:true,status:{state:payload.type==="AT_PAGE_START"?"running":"idle",
          readyToStart:payload.type!=="AT_PAGE_START",index:0,total:0}};
      }
    },
    scripting: {executeScript: async () => {}},
    storage: {
      local: {get: async () => ({}), set: async () => {}},
      session: {
        get: async key => key === null ? Object.fromEntries(storage)
          : {[key]:storage.get(key)},
        set: async entries => {
          calls.set++;
          if (failAlways || storage.has("autoTypeDraft:99")) {
            throw new Error("QUOTA_BYTES quota exceeded");
          }
          for (const [key,value] of Object.entries(entries)) storage.set(key,value);
        },
        remove: async keys => {
          calls.remove.push(keys);
          for (const key of Array.isArray(keys) ? keys : [keys]) storage.delete(key);
        }
      }
    }
  };
  const document = {getElementById:get,querySelectorAll:()=>[]};
  const window = {
    addEventListener:(name,cb) => windowEvents.set(name,cb),
    close:() => {
      calls.close++;
      closed = true;
      windowEvents.get("pagehide")?.();
      windowEvents.get("unload")?.();
    }
  };
  vm.runInNewContext(read("iframe/config-codec.js")+"\n"+read("iframe/popup.js"), {
    chrome, document, window, console,
    setTimeout, clearTimeout, setInterval, clearInterval
  });
  return {
    get, calls, storage,
    async ready() {await flush(); assert.equal(get("clearDraft").disabled, false);},
    async start(text) {
      get("text").value = text;
      await get("text").fire("input");
      await get("start").fire("click");
      await flush();
    },
    get closed() {return closed;},
    close() {windowEvents.get("pagehide")?.(); windowEvents.get("unload")?.();}
  };
}

test("P2: quota failure prunes closed-tab drafts, retries, and then starts", async () => {
  const h = popupHarness();
  await h.ready();
  await h.start("New important text");
  assert.equal(h.calls.set >= 2, true);
  assert.equal(h.storage.has("autoTypeDraft:99"), false);
  assert.equal(h.storage.get("autoTypeDraft:17:test"), "New important text");
  assert.equal(h.calls.start, 1);
  assert.equal(h.closed, true);
});

test("P2: persistent quota errors leave the source text in the popup and never start typing", async () => {
  const h = popupHarness({failAlways:true});
  await h.ready();
  await h.start("Keep this text");
  assert.equal(h.calls.start, 0);
  assert.equal(h.closed, false);
  assert.equal(h.get("text").value, "Keep this text");
  assert.equal(h.get("start").disabled, false);
  try {
    assert.equal(h.get("draftError").hidden, false);
    assert.match(h.get("draftErrorText").textContent, /copy it before closing/);
  } finally {
    h.close();
  }
});

test("P2: closing a tab removes its session draft in both editions", async () => {
  for (const edition of ["iframe","hybrid"]) {
    const onRemoved = [];
    const removed = [];
    const chrome = {
      runtime: {
        getManifest:() => ({permissions: edition==="hybrid" ? ["debugger"] : []}),
        onInstalled:{addListener(){}},
        onMessage:{addListener(){}}
      },
      tabs: {
        onRemoved:{addListener:fn=>onRemoved.push(fn)},
        onUpdated:{addListener(){}}
      },
      commands:{onCommand:{addListener(){}}},
      debugger:{onDetach:{addListener(){}}},
      storage:{session:{get:async()=>({"autoTypeDraft:47": "old", "autoTypeDraft:47:doc":"new","autoTypeDraft:48:doc":"keep"}),remove:async keys=>removed.push(...keys)}}
    };
    vm.runInNewContext(read(edition+"/background.js"), {chrome,console,setTimeout,clearTimeout});
    for (const handler of onRemoved) handler(47);
    await flush();
    assert.ok(removed.includes("autoTypeDraft:47"));
    assert.ok(removed.includes("autoTypeDraft:47:doc"));
    assert.ok(!removed.includes("autoTypeDraft:48:doc"));
  }
});

test("v1.0.4 beta metadata and edition parity", () => {
  for (const name of ["popup.js","content.js","background.js"]) {
    assert.equal(read("iframe/"+name),read("hybrid/"+name));
  }
  for (const edition of ["iframe","hybrid"]) {
    const manifest = JSON.parse(read(edition+"/manifest.json"));
    assert.equal(manifest.version,"1.0.4");
    assert.equal(manifest.version_name,"1.0.4-beta");
  }
});

// The old correction tests above use a hypothetical verified adapter. The real
// bridge must never advertise that capability or perform destructive editing.
test("unverified iframe never types a temporary typo or Backspace", async () => {
  const h = typingHarness({pauseAtTypo:false, verifiedCorrection:false});
  h.send("AT_PAGE_START", {text:"a", options:h.options});
  await flush(30);
  assert.equal(h.buffer.text,"HELLOa");
  assert.deepEqual(h.backspaces,[]);
  assert.equal(h.send("AT_PAGE_STATUS").status.state,"done");
});
