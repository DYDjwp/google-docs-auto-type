"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const read = file => fs.readFileSync(file, "utf8");
const flush = async (steps = 24) => {
  for (let i = 0; i < steps; i++) await new Promise(resolve => setImmediate(resolve));
};

function makeCdpHarness({fallback = false, blockCorrection = false, uncertainBackspace = false, secondTrustedBackspace = false, keyboardLock = false, deferBackspace = false} = {}) {
  const handlers = new Map();
  let onMessage;
  let clock = 0;
  let blockedWait = null;
  let blockNextWait = blockCorrection;
  let queuedBackspace = null;
  const buffer = {text: "HELLO", caret: 5};
  const sent = [];
  const backspaces = [];
  let trustedKeydowns = 0;
  const observedKeys = [];
  function trustedKey(key,type="keydown") {
    const e={type,key,isTrusted:true,defaultPrevented:false,stopped:false,
      preventDefault(){this.defaultPrevented=true;},
      stopImmediatePropagation(){this.stopped=true;}};
    document.dispatchEvent(e);
    observedKeys.push(e);
    return e;
  }
  class FakeEvent {
    constructor(type, options = {}) {this.type = type; this.detail = options.detail; this.key = options.key; this.isTrusted = options.isTrusted || false;}
  }
  const document = {
    addEventListener(type, callback) {
      handlers.set(type, [...(handlers.get(type) || []), callback]);
    },
    removeEventListener(type, callback) {
      handlers.set(type, (handlers.get(type) || []).filter(fn => fn !== callback));
    },
    querySelector: () => null,
    dispatchEvent(event) {
      if (event.type === "__auto_type_main_request_v3__") {
        const req = JSON.parse(event.detail);
        if (uncertainBackspace && req.action === "type") insert(req.char);
        if (uncertainBackspace && req.action === "backspace") {
          backspaces.push(buffer.caret);
          buffer.text = buffer.text.slice(0,buffer.caret-1) + buffer.text.slice(buffer.caret);
          buffer.caret--;
        }
        const reply = uncertainBackspace && req.action === "backspace"
          ? {id: req.id, ok: false, error: "Unknown result after dispatch"}
          : req.action === "type" && fallback
            ? {id: req.id, ok: false, error: "Google Docs input target is unavailable"}
            : {id: req.id, ok: true};
        queueMicrotask(() => document.dispatchEvent(new FakeEvent("__auto_type_main_response_v3__", {
          detail: JSON.stringify(reply)
        })));
      }
      for (const callback of [...(handlers.get(event.type) || [])]) {
        callback(event);
        if(event.stopped) break;
      }
      return !event.defaultPrevented;
    }
  };
  const insert = char => {
    buffer.text = buffer.text.slice(0,buffer.caret) + char + buffer.text.slice(buffer.caret);
    buffer.caret += char.length;
    sent.push(char);
  };
  const chrome = {runtime: {
    getManifest: () => ({permissions: ["debugger"]}),
    onMessage: {addListener: fn => {onMessage = fn;}},
    async sendMessage(message) {
      if (message.type === "AT_BG_INSERT") {
        insert(message.char);
      } else if (message.type === "AT_BG_BACKSPACE") {
        const dispatch = () => {
          // Model a trusted CDP keydown, delivered after an arbitrarily long
          // background queue. A prevented keydown must not edit the document.
          trustedKeydowns++;
          const own=trustedKey("Backspace");
          if (secondTrustedBackspace) trustedKey("Backspace");
          if (!own.defaultPrevented) {
            backspaces.push(buffer.caret);
            if (buffer.caret > 0) {
              buffer.text = buffer.text.slice(0,buffer.caret-1) + buffer.text.slice(buffer.caret);
              buffer.caret--;
            }
          }
          trustedKey("Backspace","keyup");
        };
        if (deferBackspace) {
          return new Promise(resolve => {
            queuedBackspace = () => {dispatch();resolve({ok:true});};
          });
        }
        dispatch();
      } else if (message.type === "AT_BG_WAIT") {
        if (blockNextWait) {
          blockNextWait = false;
          return new Promise(resolve => {
            blockedWait = () => {clock += message.ms; resolve({ok:true});};
          });
        }
        clock += message.ms;
      }
      return {ok:true};
    }
  }};
  const rand = Object.create(Math);
  rand.random = () => 0;
  const logger = {warn(){},info(){},error(){}};
  vm.runInNewContext(read("hybrid/content.js"), {
    chrome,document,window:{},Math:rand,console:logger,
    performance:{now:() => clock},setTimeout,clearTimeout,
    // Avoid real polling timers in the isolated content-script harness.
    setInterval: () => 1, clearInterval: () => {},
    Event:FakeEvent,CustomEvent:FakeEvent
  }, {filename:"hybrid/content.js"});
  const send = (type,data={}) => {
    let result;
    onMessage({type,...data},{},value=>{result=value;});
    return result;
  };
  const options = {mode:fallback||uncertainBackspace?"auto":"cdp",advancedMode:true,showOverlay:false,
    startDelay:0,fixTypo:true,fixChance:35,fixPauseMs:400,
    cpm:1800,jitter:0,rest:false,keyboardLock};
  return {
    send,options,buffer,sent,backspaces,observedKeys,
    get trustedKeydowns(){return trustedKeydowns;},
    get blocked(){return !!blockedWait;},
    get backspaceQueued(){return !!queuedBackspace;},
    get correctionGuardCount(){return (handlers.get("keydown") || []).length;},
    releaseBackspace() {
      assert.ok(queuedBackspace,"CDP Backspace was not queued");
      const pending=queuedBackspace;queuedBackspace=null;pending();
    },
    release(){assert.ok(blockedWait);const fn=blockedWait;blockedWait=null;fn();},
    fireTrustedKey(key){
      document.dispatchEvent({type:"keydown",key,isTrusted:true,preventDefault(){},stopImmediatePropagation(){}});
    },
    async waitForQueuedBackspace(){
      for(let i=0;i<80&&!queuedBackspace;i++)await flush(1);
      assert.ok(queuedBackspace,"CDP Backspace command should still be in-flight");
      assert.equal(buffer.text,"HELLOs");
    },
    async waitForCorrection(){
      for(let i=0;i<50&&!blockedWait;i++) await flush(1);
      assert.ok(blockedWait,"correction pause should be pending");
      assert.equal(buffer.text,"HELLOs");
    },
    async waitForFinish(){
      for(let i=0;i<75;i++){
        const state=send("AT_PAGE_STATUS").status.state;
        if(state==="done"||state==="stopped"||state==="error")return;
        await flush(1);
      }
      assert.fail("typing did not finish");
    }
  };
}

for (const fallback of [false,true]) {
  test("P1: CDP never schedules correction Backspace"+(fallback?" (auto fallback)":" (CDP only)"),async()=>{
    const h=makeCdpHarness({fallback,deferBackspace:true});
    const result=h.send("AT_PAGE_START",{text:"a",options:h.options});
    assert.equal(result.ok,true);
    await h.waitForFinish();
    const status=h.send("AT_PAGE_STATUS").status;
    assert.equal(status.state,"done",status.error);
    assert.equal(status.index,1);
    assert.equal(h.buffer.text,"HELLOa");
    assert.deepEqual(h.sent,["a"]);
    assert.deepEqual(h.backspaces,[]);
    assert.equal(h.backspaceQueued,false);
    assert.equal(h.trustedKeydowns,0);
  });
}
test("P1: optional intentional CDP typo does not trigger destructive correction",async()=>{
  const h=makeCdpHarness({deferBackspace:true});
  h.options.typo=true;
  h.options.typoChance=100;
  h.send("AT_PAGE_START",{text:"a",options:h.options});
  await h.waitForFinish();
  assert.equal(h.buffer.text,"HELLOs");
  assert.deepEqual(h.sent,["s"]);
  assert.deepEqual(h.backspaces,[]);
  assert.equal(h.backspaceQueued,false);
});

function makePopupHarness({holdSave=false, edition="iframe", manifest={permissions:[],version:"1.0.4"}, holdStatus=false, holdCleanup=false, recoverOnCleanup=false} = {}) {
  class Element {
    constructor(){
      this.textContent="";this.value="";this.hidden=false;this.disabled=false;
      this.checked=false;this.style={};this.events=new Map();
      this.classList={toggle(){},add(){},remove(){}};
    }
    addEventListener(type,handler){this.events.set(type,[...(this.events.get(type)||[]),handler]);}
    setAttribute(){}
    fire(type){return Promise.all((this.events.get(type)||[]).map(fn=>fn({type})));}
  }
  const elements = new Map();
  const get = id => {
    if(!elements.has(id)) elements.set(id,new Element());
    return elements.get(id);
  };
  get("draftError").hidden=true;
  let canSave=false;
  let releaseSave;
  const gate = holdSave ? new Promise(resolve=>{releaseSave=resolve;}) : Promise.resolve();
  let started=0,closed=false;
  let statusReads=0, releaseStatus;
  let pageState="idle", cleanupReady=!holdCleanup;
  const intervals=[];
  const storage = new Map([["autoTypeDraft:17","Saved"],["autoTypeDraft:99","Old"]]);
  const chrome = {
    runtime:{getManifest:()=>manifest},
    commands:{getAll:async()=>[]},
    tabs:{
      query:async query=>query.active ? [{id:17,url:"https://docs.google.com/document/d/xyz/edit"}] : [{id:17}],
      sendMessage:async(id,payload)=>{
        if(payload.type==="AT_PAGE_START") { started++; pageState="running"; }
        if(payload.type==="AT_PAGE_STOP") pageState="stopped";
        if(payload.type==="AT_PAGE_PAUSE") pageState="paused";
        if(payload.type==="AT_PAGE_RESUME") pageState="running";
        if(payload.type==="AT_PAGE_STATUS" && ++statusReads>1 && holdStatus) {
          await new Promise(resolve=>{releaseStatus=resolve;});
          return {ok:true,status:{state:"running",readyToStart:false,index:0,total:1}};
        }
        return {ok:true,status:{state:pageState,
          readyToStart:!["running","paused"].includes(pageState) && (pageState!=="stopped" || cleanupReady),
          index:0,total:0}};
      }
    },
    scripting:{executeScript:async()=>{}},
    storage:{
      local:{get:async()=>({}),set:async()=>{}},
      session:{
        get:async key=>key===null?Object.fromEntries(storage):{[key]:storage.get(key)},
        set:async values=>{
          await gate;
          if(!canSave)throw new Error("QUOTA_BYTES quota exceeded");
          for(const [key,value] of Object.entries(values)) storage.set(key,value);
        },
        remove:async keys=>{
          for(const key of Array.isArray(keys)?keys:[keys])storage.delete(key);
          if(recoverOnCleanup && Array.isArray(keys))canSave=true;
        }
      }
    }
  };
  const handlers = new Map();
  const window={
    addEventListener:(type,fn)=>handlers.set(type,fn),
    close(){closed=true; handlers.get("pagehide")?.();handlers.get("unload")?.();}
  };
  vm.runInNewContext(read(edition+"/config-codec.js")+"\n"+read(edition+"/popup.js"),{
    chrome,document:{getElementById:get,querySelectorAll:()=>[]},
    window,console,
    setTimeout,clearTimeout,
    setInterval:(fn,delay)=>{intervals.push({fn,delay});return intervals.length;},
    clearInterval(){}
  },{filename:"iframe/popup.js"});
  return {
    get,storage,
    async edit(value){
      get("text").value=value;
      await get("text").fire("input");
      await flush();
    },
    releaseStatus(){releaseStatus?.();},
    releaseCleanup(){cleanupReady=true;},
    releaseSave(){releaseSave?.();},
    setCanSave(v){canSave=v;},
    get started(){return started;},
    get closed(){return closed;},
    async ready(){await flush();},
    async start(value){
      get("text").value=value;
      await get("text").fire("input");
      await get("start").fire("click");
      await flush();
    },
    async poll(){for(const item of intervals)await item.fn();}
  };
}

test("P2: draft quota error notice remains multiline and visible after status polling",async()=>{
  const h=makePopupHarness();
  await h.ready();
  await h.start("Important original document content");
  assert.equal(h.started,0);
  assert.equal(h.closed,false);
  assert.equal(h.get("draftError").hidden,false);
  assert.match(h.get("draftErrorText").textContent,/copy it before closing/);
  await h.poll(); // Simulates the normal 850ms poll that overwrote state.
  assert.equal(h.get("state").textContent,"Ready · Text will be typed into the current Google Doc");
  assert.equal(h.get("draftError").hidden,false,"poll must never hide the banner");
  assert.match(h.get("draftErrorText").textContent,/copy it before closing/);
  assert.equal(h.get("text").value,"Important original document content");
  assert.match(read("iframe/popup.html"),/id="draftError"[^>]*role="alert"/);
  assert.match(read("iframe/popup.css"),/\.draft-error-text\{[^}]*white-space:normal;[^}]*overflow-wrap:anywhere/);
});

test("P2: error notice can be dismissed and stays hidden during subsequent polling",async()=>{
  const h=makePopupHarness();
  await h.ready();
  await h.start("Important");
  assert.equal(h.get("draftError").hidden,false);
  await h.get("dismissDraftError").fire("click");
  assert.equal(h.get("draftError").hidden,true);
  await h.poll();
  assert.equal(h.get("draftError").hidden,true);
});

test("P2: successful retry clears previous draft warning",async()=>{
  const h=makePopupHarness();
  await h.ready();
  await h.start("Important");
  assert.equal(h.get("draftError").hidden,false);
  h.setCanSave(true);
  await h.start("Important");
  assert.equal(h.started,1);
  assert.equal(h.closed,true);
  assert.equal(h.get("draftError").hidden,true);
  assert.equal(h.storage.get("autoTypeDraft:17"),"Important");
});

test("both extension editions share the same CDP guard and popup alert",()=>{
  for(const name of ["content.js","popup.js","popup.html","popup.css"]){
    assert.equal(read("iframe/"+name),read("hybrid/"+name),name);
  }
});

test("review: ambiguous iframe Backspace is never repeated via CDP",async()=>{
  const h=makeCdpHarness({uncertainBackspace:true});
  h.send("AT_PAGE_START",{text:"a",options:h.options});
  await h.waitForFinish();
  const status=h.send("AT_PAGE_STATUS").status;
  assert.equal(status.state,"error");
  assert.equal(status.index,0);
  assert.equal(h.buffer.text,"HELLO");
  assert.deepEqual(h.backspaces,[6]);
  assert.equal(h.trustedKeydowns,0);
});

test("review: CDP Fix typo does not generate or exempt trusted Backspace",async()=>{
  const h=makeCdpHarness({secondTrustedBackspace:true,deferBackspace:true});
  h.send("AT_PAGE_START",{text:"a",options:h.options});
  await h.waitForFinish();
  assert.equal(h.send("AT_PAGE_STATUS").status.state,"done");
  assert.equal(h.buffer.text,"HELLOa");
  assert.deepEqual(h.sent,["a"]);
  assert.deepEqual(h.backspaces,[]);
  assert.equal(h.backspaceQueued,false);
  assert.deepEqual(h.observedKeys,[]);
});

test("review: status polling cannot unlock Start or Clear draft during pending save",async()=>{
  const h=makePopupHarness({holdSave:true});
  await h.ready();
  h.setCanSave(true);
  const first=h.start("Keep source");
  await flush();
  await h.poll();
  assert.equal(h.get("start").disabled,true);
  assert.equal(h.get("clearDraft").disabled,true);
  assert.equal(h.get("text").disabled,true);
  await h.get("start").fire("click");
  await h.get("clearDraft").fire("click");
  assert.equal(h.get("text").value,"Keep source");
  h.releaseSave();
  await first;
  assert.equal(h.started,1);
});

test("review: neither keyboard-lock mode receives a synthetic CDP Backspace",async()=>{
  for (const keyboardLock of [false,true]) {
    const h=makeCdpHarness({keyboardLock,deferBackspace:true});
    h.send("AT_PAGE_START",{text:"a",options:h.options});
    await h.waitForFinish();
    assert.equal(h.buffer.text,"HELLOa");
    assert.equal(h.backspaceQueued,false);
    assert.deepEqual(h.observedKeys,[]);
  }
});

for (const edition of ["iframe","hybrid"]) {
  test(edition + ": popup dynamically prefers manifest version_name with version fallback",async()=>{
    for(const [manifest,expected] of [
      [{permissions:[],version:"7.8.9",version_name:"7.8.9-beta"},"v7.8.9-beta"],
      [{permissions:[],version:"9.4.2"},"v9.4.2"]
    ]) {
      const h=makePopupHarness({edition,manifest});
      await h.ready();
      assert.equal(h.get("extensionVersion").textContent,expected);
    }
    assert.match(read(edition+"/popup.html"),/id="extensionVersion"/);
  });
}
test("review: stale popup status reply cannot overwrite a completed Stop command",async()=>{
  const h=makePopupHarness({holdStatus:true});
  await h.ready();
  const polling=h.poll();
  await flush();
  await h.get("stop").fire("click");
  assert.match(h.get("state").textContent,/Stopped/);
  h.releaseStatus();
  await polling;
  assert.match(h.get("state").textContent,/Stopped/);
  assert.equal(h.get("start").disabled,false);
});

for(const edition of ["iframe","hybrid"]){
  test(edition + ": autosave quota failure is visible before Start and survives polling",async()=>{
    const h=makePopupHarness({edition});
    await h.ready();
    await h.edit("Unsaved modification");
    assert.equal(h.started,0);
    assert.equal(h.get("draftError").hidden,false);
    assert.match(h.get("draftErrorText").textContent,/copy it before closing/i);
    await h.poll();
    assert.equal(h.get("draftError").hidden,false);
    h.setCanSave(true);
    await h.edit("Newest draft");
    assert.equal(h.storage.get("autoTypeDraft:17"),"Newest draft");
    assert.equal(h.get("draftError").hidden,true);
  });
  test(edition + ": autosave recovers by reclaiming closed-tab drafts without Start",async()=>{
    const h=makePopupHarness({edition,recoverOnCleanup:true});
    await h.ready();
    await h.edit("Recovered draft");
    assert.equal(h.storage.get("autoTypeDraft:17"),"Recovered draft");
    assert.equal(h.storage.has("autoTypeDraft:99"),false);
    assert.equal(h.get("draftError").hidden,true);
    assert.equal(h.started,0);
  });
  test(edition + ": pending autosave cannot resurrect cleared draft",async()=>{
    const h=makePopupHarness({edition,holdSave:true});
    await h.ready();
    h.setCanSave(true);
    const edit=h.edit("Old unsaved");
    await flush();
    const clear=h.get("clearDraft").fire("click");
    h.releaseSave();
    await Promise.all([edit,clear]);
    assert.equal(h.storage.has("autoTypeDraft:17"),false);
    assert.equal(h.get("text").value,"");
  });
}

for(const keyboardLock of [false,true]){
  test("P1: no destructive command can remain queued after CDP typing (keyboardLock="+keyboardLock+")",async()=>{
    const h=makeCdpHarness({keyboardLock,deferBackspace:true});
    h.send("AT_PAGE_START",{text:"a",options:h.options});
    await h.waitForFinish();
    assert.equal(h.buffer.text,"HELLOa");
    assert.deepEqual(h.backspaces,[]);
    assert.equal(h.backspaceQueued,false);
    assert.equal(h.trustedKeydowns,0);
    assert.equal(h.send("AT_PAGE_STATUS").status.index,1);
  });
}

for (const edition of ["iframe","hybrid"]) {
  test(edition+": Stop keeps Start disabled while cleanup is pending and re-enables it after status poll",async()=>{
    const h=makePopupHarness({edition,holdCleanup:true});
    h.setCanSave(true);
    await h.ready();
    await h.start("First draft");
    assert.equal(h.started,1);
    await h.get("stop").fire("click");
    assert.match(h.get("state").textContent,/Stopped.*Cleaning up/);
    assert.equal(h.get("start").disabled,true);
    await h.get("start").fire("click");
    assert.equal(h.started,1,"a synthetic early Start must be ignored");
    await h.poll();
    assert.equal(h.get("start").disabled,true,"status polling must not unlock during cleanup");
    h.releaseCleanup();
    await h.poll();
    assert.equal(h.get("start").disabled,false,"fresh final status unlocks Start");
    await h.get("start").fire("click");
    assert.equal(h.started,2,"Start is usable after cleanup completes");
  });
}
