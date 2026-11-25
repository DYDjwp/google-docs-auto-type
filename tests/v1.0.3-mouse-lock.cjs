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

function event(type, {trusted = true, buttons = 0, path = [], key = ""} = {}) {
  return {
    type,
    isTrusted: trusted,
    buttons,
    key,
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
  showOverlay = false, startDelay = 1, failWait = false,
  keyboardLock = false, fixTypo = false, blockWaits = 1
} = {}) {
  const window = new FakeTarget();
  const document = new FakeTarget();
  const innerWindow = new FakeTarget();
  const innerDoc = new FakeTarget();
  let frame = {contentWindow: innerWindow, contentDocument: innerDoc};
  let onMessage;
  let elapsed = 0;
  let waitResolve = null;
  let blockedCount = 0;
  let nextInterval = 0;
  const intervals = new Map();
  const logs = [];
  let overlayHost = null, overlayButtons = null;
  const edits = [];
  const rand = Object.create(Math);
  rand.random = () => 0;

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
      if (["type", "backspace", "enter"].includes(request.action)) edits.push(request);
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
        if (blockedCount < blockWaits) {
          blockedCount++;
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
    chrome,document,window,Math:rand,
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
  const options = {advancedMode, mouseLock, showOverlay, keyboardLock,
    startDelay, speed:"fast", mode:"iframe", fixTypo, fixChance:35, fixPauseMs:400, jitter:0, rest:false};
  return {
    window, document, innerWindow, innerDoc, send, options, logs, edits,
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
    async waitForPacing() {
      for(let i=0;i<25 && !waitResolve;i++) await flush(1);
      assert.ok(waitResolve);
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
    assert.equal(h.window.count("wheel"),1);
    assert.equal(h.send("AT_PAGE_PAUSE").status.state,"paused");
    assert.equal(h.window.count("wheel"),0);
    const free=event("click");
    h.document.dispatchEvent(free);
    assert.equal(free.defaultPrevented,false);
    assert.equal(h.send("AT_PAGE_RESUME").status.state,"running");
    assert.equal(h.window.count("wheel"),1);
    const blocked=event("click");
    h.document.dispatchEvent(blocked);
    assert.equal(blocked.defaultPrevented,true);
    assert.equal(h.send("AT_PAGE_STOP").status.state,"stopped");
    assert.equal(h.window.count("wheel"),0);
    assert.equal(h.document.count("wheel"),0);
    await h.finish();
    assert.equal(h.document.count("pointerdown"),0,"correction guard must also clean up on completion");
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
    assert.equal(oldDoc.count("wheel"),1);
    assert.equal(newDoc.count("wheel"),1);
    assert.equal(newWindow.count("wheel"),1);
    const attemptedClick=event("click");
    newDoc.dispatchEvent(attemptedClick);
    assert.equal(attemptedClick.defaultPrevented,true);
    h.send("AT_PAGE_STOP");
    assert.equal(oldDoc.count("wheel"),0);
    assert.equal(newDoc.count("wheel"),0);
    assert.equal(newWindow.count("wheel"),0);
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
    assert.equal(h.document.count("wheel"),0,"pause must release Mouse lock");
    h.overlayButtons.get("#toggle").dispatchEvent(event("click"));
    assert.equal(h.send("AT_PAGE_STATUS").status.state,"running");
    assert.equal(h.document.count("wheel"),1,"resume must restore Mouse lock");
    h.overlayButtons.get("#stop").dispatchEvent(event("click"));
    assert.equal(h.send("AT_PAGE_STATUS").status.state,"stopped");
    assert.equal(h.document.count("wheel"),0);
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
    assert.equal(JSON.parse(read(edition+"/manifest.json")).version_name,"1.0.4-beta");
  }
});

test("Mouse lock doesn't require new browser permissions",()=>{
  const iframe=JSON.parse(read("iframe/manifest.json"));
  const hybrid=JSON.parse(read("hybrid/manifest.json"));
  assert.deepEqual(iframe.permissions,["storage","scripting"]);
  assert.deepEqual(hybrid.permissions,["storage","scripting","debugger"]);
  assert.equal(read("iframe/content.js"),read("hybrid/content.js"));
  assert.equal(read("iframe/popup.html"),read("hybrid/popup.html"));
});

test("review: pause during initial iframe probe does not install mouse lock",async()=>{
  const h=makeHarness();
  assert.equal(h.send("AT_PAGE_START",{text:"abc",options:h.options}).ok,true);
  assert.equal(h.send("AT_PAGE_PAUSE").status.state,"paused");
  await flush();
  assert.equal(h.window.count("wheel"),0);
  assert.equal(h.document.count("wheel"),0);
  h.send("AT_PAGE_STOP");
  await h.finish();
});

test("review: floating button mousedown preserves editor focus",async()=>{
  const h=makeHarness({showOverlay:true});
  await h.start();
  const down=event("mousedown");
  h.overlayButtons.get("#toggle").dispatchEvent(down);
  assert.equal(down.defaultPrevented,true);
  h.send("AT_PAGE_STOP");
  await h.finish();
});

for (const edition of ["iframe", "hybrid"]) {
  test(edition + ": keyboard lock consumes manual keys before correction safety guard", async () => {
    const h = makeHarness({edition, keyboardLock:true, fixTypo:true, startDelay:0});
    await h.start("a");
    assert.deepEqual(h.edits.map(e=>e.action),["type"]);
    for (const target of [h.document, h.innerDoc]) {
      const key = event("keydown",{key:"x"});
      target.dispatchEvent(key);
      assert.equal(key.defaultPrevented,true);
      assert.equal(key.stopped,true);
      assert.equal(h.send("AT_PAGE_STATUS").status.state,"running");
    }
    await h.finish();
    assert.equal(h.send("AT_PAGE_STATUS").status.state,"done");
    assert.equal(h.send("AT_PAGE_STATUS").status.index,1);
    assert.deepEqual(h.edits.map(e=>e.action),["type","backspace","type"]);
  });

  test(edition + ": Escape pauses, consumes the key, and does not delete pending typo", async () => {
    const h = makeHarness({edition, keyboardLock:true, fixTypo:true, startDelay:0});
    await h.start("a");
    const esc = event("keydown",{key:"Escape"});
    h.document.dispatchEvent(esc);
    assert.equal(esc.defaultPrevented,true);
    assert.equal(esc.stopped,true);
    assert.equal(h.send("AT_PAGE_STATUS").status.state,"paused");
    h.send("AT_PAGE_STOP");
    await h.finish();
    assert.deepEqual(h.edits.map(e=>e.action),["type"]);
  });

  for (const mouseLock of [false,true]) {
    for (const [button,expected] of [["#close","running"],["#toggle","paused"],["#stop","stopped"]]) {
      test(edition + ": correction panel " + button + " obeys its own handler (mouseLock=" + mouseLock + ")", async () => {
        const h=makeHarness({edition,mouseLock,showOverlay:true,fixTypo:true,startDelay:0});
        await h.start("a");
        const host=h.overlayHost;
        for(const type of ["pointerdown","mousedown"]) {
          const e=event(type,{path:[host,h.document,h.window]});
          h.window.dispatchEvent(e);
          h.document.dispatchEvent(e);
          assert.equal(h.send("AT_PAGE_STATUS").status.state,"running");
          assert.equal(e.stopped,false);
        }
        h.overlayButtons.get(button).dispatchEvent(event("click"));
        assert.equal(h.send("AT_PAGE_STATUS").status.state,expected);
        if(button==="#close"){
          assert.equal(host.isConnected,false);
          await h.finish();
          assert.equal(h.send("AT_PAGE_STATUS").status.state,"done");
          assert.deepEqual(h.edits.map(e=>e.action),["type","backspace","type"]);
        } else {
          if(expected==="paused")h.send("AT_PAGE_STOP");
          await h.finish();
          assert.deepEqual(h.edits.map(e=>e.action),["type"]);
        }
      });
    }
  }
}

for (const edition of ["iframe","hybrid"]) {
  test(edition + ": correction refuses Backspace after editor iframe replacement", async () => {
    const h=makeHarness({edition,fixTypo:true,startDelay:0});
    await h.start("a");
    assert.deepEqual(h.edits.map(e=>e.action),["type"]);
    h.replaceFrame();
    h.pollFrames();
    await h.finish();
    const status=h.send("AT_PAGE_STATUS").status;
    assert.equal(status.state,"stopped");
    assert.equal(status.index,0);
    assert.deepEqual(h.edits.map(e=>e.action),["type"]);
  });
}

for(const edition of ["iframe","hybrid"]) {
  for(const keyboardLock of [true,false]) {
    test(edition + ": new iframe is protected before correction without any polling (keyboard=" + keyboardLock + ")", async()=>{
      const h=makeHarness({edition,keyboardLock,fixTypo:true,startDelay:0,blockWaits:2});
      // One ordinary character delay fits in a single pacing slice.
      h.options.cpm=1800;
      await h.start("1a");
      assert.equal(h.edits[0].char,"1");
      const {newDoc}=h.replaceFrame();
      // No pollFrames call: release ordinary pacing and reach the typo wait.
      h.release();
      await h.waitForPacing();
      assert.equal(h.edits.length,2);
      assert.equal(h.edits[1].action,"type");
      for(let i=0;i<2;i++){
        const key=event("keydown",{key:"ArrowLeft"});
        newDoc.dispatchEvent(key);
        if(keyboardLock) assert.equal(key.defaultPrevented,true);
      }
      await h.finish();
      const status=h.send("AT_PAGE_STATUS").status;
      assert.equal(status.state,keyboardLock?"done":"stopped");
      assert.equal(h.edits.filter(e=>e.action==="backspace").length,keyboardLock?1:0);
      assert.equal(status.index,keyboardLock?2:1);
    });
  }
}
