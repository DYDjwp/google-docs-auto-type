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
      event.currentTarget = this;
      handler(event);
      if (event.stopped) break;
    }
    return !event.defaultPrevented;
  }
}

function event(type, {trusted = true, buttons = 0, path = [], key = "", movementX = 0, movementY = 0, editor = false} = {}) {
  return {
    type,
    isTrusted: trusted,
    buttons,
    key, movementX, movementY, target: {closest: selector => editor && selector.includes(".kix-page") ? {} : null},
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
  keyboardLock = false, fixTypo = false, blockWaits = 1, selection = {start:5,end:5}, notifications = false, holdCorrection = false, holdRestore = false, restoreFails = false
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
  let overlayHost = null, overlayButtons = null, noticeHost = null, noticeButtons = null;
  const edits = [], requests = [];
  let currentSelection = selection, correctionReply = null, restoreReply = null;
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
    Object.defineProperty(host,'id',{set(id){if(id==='auto-type-notice-root'){noticeHost=host;noticeButtons=controls;}else{overlayHost=host;overlayButtons=controls;}}});
    return host;
  };
  document.body = {append(host) {host.isConnected = true;}};
  const realDispatch = document.dispatchEvent.bind(document);
  document.dispatchEvent = payload => {
    if (payload.type === "__auto_type_main_request_v3__") {
      const request = JSON.parse(payload.detail);
      requests.push(request);
      const reply = extra => document.dispatchEvent({type:"__auto_type_main_response_v3__",detail:JSON.stringify({id:request.id,ok:true,...extra})});
      if (request.action === "correct" && holdCorrection) {
        correctionReply = () => reply({corrected:false});
        return true;
      }
      if (request.action === "cancelOperation" && correctionReply) {correctionReply();correctionReply=null;}
      if (request.action === "restoreSelection" && holdRestore) {
        restoreReply = () => {if(!restoreFails)currentSelection=request.selection;reply({restored:!restoreFails});};
        return true;
      }
      if (["type", "backspace", "enter"].includes(request.action)) {
        edits.push(request);
        if (currentSelection) {const at=currentSelection.start+(request.char?.length || 1);currentSelection={start:at,end:at};}
      }
      if(request.action==="restoreSelection") currentSelection=request.selection;
      queueMicrotask(() => document.dispatchEvent({
        type: "__auto_type_main_response_v3__",
        detail: JSON.stringify({id: request.id, ok: true, ...(request.action === "selection" ? {selection:currentSelection} : request.action === "restoreSelection" ? {restored:true} : {})})
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
    startDelay, speed:"fast", mode:"iframe", notifications, fixTypo, fixChance:35, fixPauseMs:400, jitter:0, rest:false};
  return {
    window, document, innerWindow, innerDoc, send, options, logs, edits, requests,
    get currentSelection(){return currentSelection;},
    get correcting(){return !!correctionReply;},
    releaseRestore(){assert.ok(restoreReply);restoreReply();restoreReply=null;},
    setSelection(value) {currentSelection = value;},
    get noticeHost() {return noticeHost;},
    get noticeButtons() {return noticeButtons;},
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
      assert.equal(drag.defaultPrevented,true,"dragging remains blocked with Mouse Lock on");
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
    assert.equal(h.send("AT_PAGE_RESUME").status.state,"paused");
    await flush();
    assert.equal(h.send("AT_PAGE_STATUS").status.state,"running");
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
      assert.equal(h.window.count("pointerdown"),1);
      assert.equal(h.document.count("wheel"),1);
      const click=event("click");
      h.document.dispatchEvent(click);
      assert.equal(click.defaultPrevented,false);
      assert.equal(h.send("AT_PAGE_STATUS").status.state,"running");
      h.send("AT_PAGE_STOP");
      await h.finish();
    }
  });

  test(edition + ": watches replacement input iframes and cleans both old and new listeners",async()=>{
    const h=makeHarness({edition});
    await h.start();
    const {oldDoc,newDoc,newWindow}=h.replaceFrame();
    h.pollFrames();
    assert.equal(oldDoc.count("wheel"),0);
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
    await flush();
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

for (const edition of ["iframe","hybrid"]) {
  for (const mouseLock of [false,true]) {
    test(edition+" mouse movement never pauses (mouseLock="+mouseLock+")",async()=>{
      const h=makeHarness({edition,mouseLock,startDelay:0});
      await h.start("ab");
      h.innerDoc.dispatchEvent(event("pointermove",{movementX:20}));
      h.document.dispatchEvent(event("mousemove",{movementY:12,editor:true}));
      assert.equal(h.send("AT_PAGE_STATUS").status.state,"running");
      h.send("AT_PAGE_STOP");await h.finish();
    });
  }
  test(edition+" clicks and arrow keys alone do not pause; actual caret movement does",async()=>{
    const h=makeHarness({edition,mouseLock:false,startDelay:0});
    await h.start("ab");
    for(const type of ["pointerdown","mousedown","click","wheel","keydown"]){
      h.innerDoc.dispatchEvent(event(type,{editor:true,key:"ArrowLeft"}));
      h.pollFrames();await flush();
      assert.equal(h.send("AT_PAGE_STATUS").status.state,"running");
    }
    h.setSelection({start:2,end:2});
    h.pollFrames();await flush();
    assert.equal(h.send("AT_PAGE_STATUS").status.state,"paused");
    assert.equal(h.edits.length,1);
    h.send("AT_PAGE_RESUME");await flush();
    assert.deepEqual(h.currentSelection,{start:6,end:6});
    await h.finish();
    assert.deepEqual(h.edits.map(e=>e.char),["a","b"]);
  });
  test(edition+" optional keyboard lock consumes keys without event-driven pause",async()=>{
    for(const keyboardLock of [false,true]){
      const h=makeHarness({edition,keyboardLock,startDelay:0});
      await h.start("ab");
      const e=event("keydown",{key:"ArrowLeft"});
      h.innerDoc.dispatchEvent(e);
      assert.equal(e.defaultPrevented,keyboardLock);
      assert.equal(h.send("AT_PAGE_STATUS").status.state,"running");
      if(keyboardLock){
        h.innerDoc.dispatchEvent(event("keydown",{key:"Escape"}));
        assert.equal(h.send("AT_PAGE_STATUS").status.state,"paused");
      }
      h.send("AT_PAGE_STOP");await h.finish();
    }
  });
  test(edition+" frame replacement rebinds guard before next input and leaves no old listeners",async()=>{
    const h=makeHarness({edition,mouseLock:false,startDelay:0,blockWaits:2});
    h.options.cpm=1800; // Each inter-character delay fits in one pacing slice.
    await h.start("abc");
    const {oldDoc,newDoc}=h.replaceFrame();
    h.release();
    await h.waitForPacing();
    assert.equal(oldDoc.count("pointermove"),0);
    assert.equal(newDoc.count("pointermove"),1);
    h.setSelection({start:1,end:1});
    h.pollFrames();await flush();
    assert.equal(h.send("AT_PAGE_STATUS").status.state,"paused");
    h.send("AT_PAGE_STOP");
    await h.finish();
    assert.deepEqual(h.edits.map(e=>e.char),["a","b"]);
  });
}

for(const edition of ["iframe","hybrid"]){
  for(const restoreFails of [false,true]){
    test(edition+" Resume awaits logical caret restoration (failure="+restoreFails+")",async()=>{
      const h=makeHarness({edition,mouseLock:false,startDelay:0,selection:{start:5,end:5},holdRestore:true,restoreFails});
      await h.start("ab");
      h.send("AT_PAGE_PAUSE");
      h.setSelection({start:1,end:1});
      h.send("AT_PAGE_RESUME");
      assert.equal(h.send("AT_PAGE_STATUS").status.state,"paused");
      assert.equal(h.send("AT_PAGE_STATUS").status.restoring,true);
      assert.equal(h.edits.length,1);
      const restore=h.requests.find(x=>x.action==="restoreSelection");
      assert.deepEqual(restore.selection,{start:6,end:6});
      h.releaseRestore();await flush();
      if(restoreFails){
        assert.equal(h.send("AT_PAGE_STATUS").status.state,"stopped");
        assert.match(h.send("AT_PAGE_STATUS").status.error,/Automatic caret restoration failed/);
        assert.equal(h.edits.length,1);
        h.send("AT_PAGE_STOP");
      } else {
        assert.equal(h.currentSelection.start,6);
        assert.equal(h.send("AT_PAGE_STATUS").status.state,"running");
      }
      await h.finish();
      assert.equal(h.edits.length,restoreFails?1:2);
    });
  }
  test(edition+" pause during correction cancels task and notifies user",async()=>{
    const h=makeHarness({edition,mouseLock:false,startDelay:0,selection:{start:5,end:5},fixTypo:true,holdCorrection:true});
    assert.equal(h.send("AT_PAGE_START",{text:"ab",options:h.options}).ok,true);
    for(let i=0;i<30&&!h.correcting;i++)await flush(1);
    assert.ok(h.correcting);
    h.send("AT_PAGE_PAUSE");
    assert.equal(h.send("AT_PAGE_STATUS").status.state,"stopped");
    assert.match(h.send("AT_PAGE_STATUS").status.error,/Correction interrupted/);
    await h.finish();
    assert.equal(h.send("AT_PAGE_STATUS").status.index,0);
    assert.ok(h.requests.some(r=>r.action==="cancelOperation"));
    assert.equal(h.edits.length,0);
  });
}

for(const edition of ["iframe","hybrid"]){
  test(edition+" caret monitoring is independent of DOM events, including long waits",async()=>{
    const h=makeHarness({edition,mouseLock:false,startDelay:0});
    await h.start("ab");
    h.setSelection({start:2,end:2});
    h.pollFrames();await flush();
    assert.equal(h.send("AT_PAGE_STATUS").status.state,"paused");
    h.send("AT_PAGE_RESUME");await flush();
    assert.equal(h.currentSelection.start,6);
    await h.finish();
    assert.equal(h.currentSelection.start,7);
  });
  test(edition+" unavailable model never guesses a caret or permits unverified Resume",async()=>{
    const h=makeHarness({edition,mouseLock:false,startDelay:0,selection:null});
    await h.start("ab");
    h.innerDoc.dispatchEvent(event("click",{editor:true}));h.pollFrames();await flush();
    assert.equal(h.send("AT_PAGE_STATUS").status.state,"running");
    h.send("AT_PAGE_PAUSE");h.send("AT_PAGE_RESUME");await flush();
    assert.equal(h.send("AT_PAGE_STATUS").status.state,"stopped");
    assert.match(h.send("AT_PAGE_STATUS").status.error,/Automatic caret restoration failed/);
    await h.finish();assert.equal(h.edits.length,1);
  });
  for(const notifications of [true,false]){
    test(edition+" standalone notice respects notification preference ("+notifications+")",async()=>{
      const h=makeHarness({edition,mouseLock:false,showOverlay:false,startDelay:0,notifications});
      await h.start("ab");
      h.setSelection({start:1,end:1});h.pollFrames();await flush();
      assert.equal(h.send("AT_PAGE_STATUS").status.state,"paused");
      assert.equal(!!h.noticeHost?.isConnected,notifications);
      assert.equal(!!h.overlayHost?.isConnected,false);
      if(notifications){
        assert.match(h.noticeButtons.get("#message").textContent,/Document caret moved/);
        h.noticeButtons.get("#dismiss").dispatchEvent(event("click"));
        assert.equal(h.noticeHost.isConnected,false);
      }
      h.send("AT_PAGE_STOP");await h.finish();
    });
  }
}
