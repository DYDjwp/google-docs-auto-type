"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const read = file => fs.readFileSync(file, "utf8");
const flush = async (steps = 8) => {
  for (let i = 0; i < steps; i++) await new Promise(resolve => setImmediate(resolve));
};

class FakeTarget {
  constructor() {
    this.listeners = new Map();
    this.style = {};
    this.isConnected = false;
  }
  addEventListener(type, handler) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), handler]);
  }
  removeEventListener(type, handler) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(fn => fn !== handler));
  }
  count(type) { return (this.listeners.get(type) || []).length; }
  dispatchEvent(event) {
    for (const handler of [...(this.listeners.get(event.type) || [])]) {
      handler(event);
      if (event.stopped) break;
    }
    return !event.defaultPrevented;
  }
}

function event(type, {trusted = true, buttons = 0, path = []} = {}) {
  return {
    type,
    isTrusted: trusted,
    buttons,
    cancelable: true,
    defaultPrevented: false,
    stopped: false,
    composedPath: () => path,
    preventDefault() { this.defaultPrevented = true; },
    stopImmediatePropagation() { this.stopped = true; }
  };
}

function makeHarness({
  edition = "iframe", advancedMode = true, mouseLock = true,
  showOverlay = false, startDelay = 1, failWait = false
} = {}) {
  const window = new FakeTarget();
  const document = new FakeTarget();
  const innerWindow = new FakeTarget();
  const innerDoc = new FakeTarget();
  let frame = {contentWindow: innerWindow, contentDocument: innerDoc};
  let onMessage;
  let elapsed = 0;
  let waitResolve = null;
  let blockedOnce = false;
  let nextInterval = 0;
  const intervals = new Map();
  const logs = [];
  let overlayHost = null, overlayButtons = null;

  document.querySelector = selector =>
    selector === "iframe.docs-texteventtarget-iframe" ? frame : null;
  document.createElement = () => {
    const host = new FakeTarget();
    host.isConnected = false;
    host.contains = target => target === host;
    host.remove = () => { host.isConnected = false; };
    const controls = new Map();
    host.attachShadow = () => ({
      innerHTML: "",
      querySelector(selector) {
        if (!controls.has(selector)) controls.set(selector, new FakeTarget());
        return controls.get(selector);
      }
    });
    overlayHost = host;
    overlayButtons = controls;
    return host;
  };
  document.body = {append(host) {host.isConnected = true;}};
  const realDispatch = document.dispatchEvent.bind(document);
  document.dispatchEvent = payload => {
    if (payload.type === "__auto_type_main_request_v3__") {
      const request = JSON.parse(payload.detail);
      queueMicrotask(() => document.dispatchEvent({
        type: "__auto_type_main_response_v3__",
        detail: JSON.stringify({id: request.id, ok: true})
      }));
    }
    return realDispatch(payload);
  };

  const chrome = {runtime: {
    getManifest: () => ({permissions: edition === "hybrid" ? ["debugger"] : []}),
    onMessage: {addListener: fn => {onMessage = fn;}},
    sendMessage: async message => {
      if (message.type === "AT_BG_WAIT") {
        if (failWait) throw new Error("Invalid wait duration");
        if (!blockedOnce) {
          blockedOnce = true;
          return new Promise(resolve => {
            waitResolve = () => {elapsed += message.ms; resolve({ok: true});};
          });
        }
        elapsed += message.ms;
      }
      return {ok: true};
    }
  }};
  vm.runInNewContext(read(edition + "/content.js"), {
    chrome,document,window,
    console: {...console, warn: (...a) => logs.push(a), error: (...a) => logs.push(a)},
    performance: {now: () => elapsed},
    setTimeout,clearTimeout,
    setInterval: callback => {const id = ++nextInterval; intervals.set(id, callback); return id;},
    clearInterval: id => {intervals.delete(id);},
    Event: class {},
    CustomEvent: class {constructor(type,opts={}) {this.type=type;this.detail=opts.detail;}}
  }, {filename:edition + "/content.js"});

  const send = (type, data = {}) => {
    let response;
    onMessage({type, ...data}, {}, value => {response = value;});
    return response;
  };
  const options = {advancedMode, mouseLock, showOverlay, keyboardLock:false,
    startDelay, speed:"fast", mode:"iframe", fixTypo:false, jitter:0, rest:false};
  return {
    window, document, innerWindow, innerDoc, send, options, logs,
    get overlayHost() {return overlayHost;},
    get overlayButtons() {return overlayButtons;},
    get waiting() {return Boolean(waitResolve);},
    async start(text = "abc") {
      const start = send("AT_PAGE_START", {text, options});
      assert.equal(start.ok,true);
      for(let i=0;i<25 && !waitResolve;i++) await flush(1);
      if (!failWait) assert.ok(waitResolve,"typing must reach the initial wait");
    },
    release() {
      assert.ok(waitResolve,"no pending pacing wait");
      const fn = waitResolve;waitResolve=null;fn();
    },
    pollFrames() {for (const cb of [...intervals.values()]) cb();},
    replaceFrame() {
      const oldDoc = frame.contentDocument;
      const newWindow = new FakeTarget();
      const newDoc = new FakeTarget();
      frame = {contentWindow:newWindow,contentDocument:newDoc};
      return {oldDoc,newWindow,newDoc};
    },
    async finish() {
      if(waitResolve) this.release();
      for(let i=0;i<50;i++){
        if(["done","stopped","error"].includes(send("AT_PAGE_STATUS").status.state)) break;
        await flush(1);
      }
      await flush();
    }
  };
}

for (const edition of ["iframe","hybrid"]) {
  test(edition + ": Mouse lock blocks real clicks, drag selection and wheel, not ordinary motion or synthetic inputs", async () => {
    const h = makeHarness({edition});
    await h.start();
    for(const target of [h.window,h.document,h.innerWindow,h.innerDoc]){
      for(const type of ["pointerdown","mousedown","click","dblclick","dragstart","selectstart","wheel","contextmenu"]){
        const e=event(type);
        target.dispatchEvent(e);
        assert.equal(e.defaultPrevented,true, target === h.innerDoc ? "iframe "+type : type);
        assert.equal(e.stopped,true,type);
      }
      const hover=event("mousemove",{buttons:0});
      target.dispatchEvent(hover);
      assert.equal(hover.defaultPrevented,false,"ordinary pointer movement stays possible");
      const drag=event("mousemove",{buttons:1});
      target.dispatchEvent(drag);
      assert.equal(drag.defaultPrevented,true,"dragging while a button is down is blocked");
      const synthetic=event("click",{trusted:false});
      target.dispatchEvent(synthetic);
      assert.equal(synthetic.defaultPrevented,false,"programmatic events stay untouched");
      assert.equal(target.count("keydown") >= 0,true);
    }
    h.send("AT_PAGE_STOP");
    assert.equal(h.window.count("pointerdown"),0);
    assert.equal(h.innerDoc.count("wheel"),0);
    await h.finish();
  });

  test(edition + ": pause releases mouse lock, resume restores it, stop removes listeners", async () => {
    const h=makeHarness({edition});
    await h.start();
    assert.equal(h.window.count("pointerdown"),1);
    assert.equal(h.send("AT_PAGE_PAUSE").status.state,"paused");
    assert.equal(h.window.count("pointerdown"),0);
    const free=event("click");
    h.document.dispatchEvent(free);
    assert.equal(free.defaultPrevented,false);
    assert.equal(h.send("AT_PAGE_RESUME").status.state,"running");
    assert.equal(h.window.count("pointerdown"),1);
    const blocked=event("click");
    h.document.dispatchEvent(blocked);
    assert.equal(blocked.defaultPrevented,true);
    assert.equal(h.send("AT_PAGE_STOP").status.state,"stopped");
    assert.equal(h.window.count("pointerdown"),0);
    assert.equal(h.document.count("pointerdown"),0);
    await h.finish();
  });

  test(edition + ": disabled in basic mode and default-off Advanced settings", async () => {
    for(const settings of [{advancedMode:false,mouseLock:true},{advancedMode:true,mouseLock:false}]) {
      const h=makeHarness({edition,...settings});
      await h.start();
      assert.equal(h.window.count("pointerdown"),0);
      assert.equal(h.document.count("wheel"),0);
      const click=event("click");
      h.document.dispatchEvent(click);
      assert.equal(click.defaultPrevented,false);
      h.send("AT_PAGE_STOP");
      await h.finish();
    }
  });

  test(edition + ": watches replacement input iframes and cleans both old and new listeners",async()=>{
    const h=makeHarness({edition});
    await h.start();
    const {oldDoc,newDoc,newWindow}=h.replaceFrame();
    h.pollFrames();
    assert.equal(oldDoc.count("pointerdown"),1);
    assert.equal(newDoc.count("pointerdown"),1);
    assert.equal(newWindow.count("pointerdown"),1);
    const attemptedClick=event("click");
    newDoc.dispatchEvent(attemptedClick);
    assert.equal(attemptedClick.defaultPrevented,true);
    h.send("AT_PAGE_STOP");
    assert.equal(oldDoc.count("pointerdown"),0);
    assert.equal(newDoc.count("pointerdown"),0);
    assert.equal(newWindow.count("pointerdown"),0);
    await h.finish();
  });

  test(edition + ": floating Pause and Stop controls remain interactive",async()=>{
    const h=makeHarness({edition,showOverlay:true});
    await h.start();
    const host=h.overlayHost;
    assert.ok(host?.isConnected,"floating controls are connected");
    const onControl=event("pointerdown",{path:[host,h.document,h.window]});
    h.window.dispatchEvent(onControl);
    assert.equal(onControl.defaultPrevented,false,"overlay buttons must be reachable");
    assert.equal(onControl.stopped,false);
    h.overlayButtons.get("#toggle").dispatchEvent(event("click"));
    assert.equal(h.send("AT_PAGE_STATUS").status.state,"paused");
    assert.equal(h.document.count("pointerdown"),0,"pause must release Mouse lock");
    h.overlayButtons.get("#toggle").dispatchEvent(event("click"));
    assert.equal(h.send("AT_PAGE_STATUS").status.state,"running");
    assert.equal(h.document.count("pointerdown"),1,"resume must restore Mouse lock");
    h.overlayButtons.get("#stop").dispatchEvent(event("click"));
    assert.equal(h.send("AT_PAGE_STATUS").status.state,"stopped");
    assert.equal(h.document.count("pointerdown"),0);
    await h.finish();
  });

  test(edition + ": normal completion and typing failure both release the guard",async()=>{
    const completed=makeHarness({edition});
    await completed.start("a");
    completed.release();
    await completed.finish();
    assert.equal(completed.send("AT_PAGE_STATUS").status.state,"done");
    assert.equal(completed.document.count("pointerdown"),0);

    const failed=makeHarness({edition,failWait:true});
    await failed.start("a");
    await flush(12);
    assert.equal(failed.send("AT_PAGE_STATUS").status.state,"error");
    assert.equal(failed.document.count("pointerdown"),0);
  });
}

test("Advanced popup exposes an off-by-default Mouse lock setting",()=>{
  for(const edition of ["iframe","hybrid"]){
    const html=read(edition + "/popup.html");
    const script=read(edition + "/popup.js");
    assert.match(html, /id="advancedPanel"/);
    assert.match(html, /for="mouseLock"/);
    assert.match(html, /<input id="mouseLock" type="checkbox">/);
    assert.ok(html.indexOf('id="mouseLock"')>html.indexOf('id="advancedPanel"'));
    assert.match(script, /mouseLock: false/);
    assert.match(script, /const TOGGLES = \[[^\]]*"mouseLock"/);
    assert.equal(JSON.parse(read(edition+"/manifest.json")).version_name,"1.0.3-dev");
  }
});

test("Mouse lock doesn't require new browser permissions or alter the stable main branch",()=>{
  const iframe=JSON.parse(read("iframe/manifest.json"));
  const hybrid=JSON.parse(read("hybrid/manifest.json"));
  assert.deepEqual(iframe.permissions,["storage","scripting"]);
  assert.deepEqual(hybrid.permissions,["storage","scripting","debugger"]);
  assert.equal(read("iframe/content.js"),read("hybrid/content.js"));
  assert.equal(read("iframe/popup.html"),read("hybrid/popup.html"));
});
