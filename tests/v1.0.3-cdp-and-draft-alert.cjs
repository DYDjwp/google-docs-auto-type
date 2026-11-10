"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const read = file => fs.readFileSync(file, "utf8");
const flush = async (steps = 24) => {
  for (let i = 0; i < steps; i++) await new Promise(resolve => setImmediate(resolve));
};

function makeCdpHarness({fallback = false, blockCorrection = false} = {}) {
  const handlers = new Map();
  let onMessage;
  let clock = 0;
  let blockedWait = null;
  let blockNextWait = blockCorrection;
  const buffer = {text: "HELLO", caret: 5};
  const sent = [];
  const backspaces = [];
  let trustedKeydowns = 0;
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
        const reply = req.action === "type" && fallback
          ? {id: req.id, ok: false, error: "iframe input failed"}
          : {id: req.id, ok: true};
        queueMicrotask(() => document.dispatchEvent(new FakeEvent("__auto_type_main_response_v3__", {
          detail: JSON.stringify(reply)
        })));
      }
      for (const callback of [...(handlers.get(event.type) || [])]) callback(event);
      return true;
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
        // Chrome's CDP keyDown is trusted, unlike iframe-synthesized DOM Events.
        trustedKeydowns++;
        document.dispatchEvent({type:"keydown",key:"Backspace",isTrusted:true,preventDefault(){},stopImmediatePropagation(){}});
        backspaces.push(buffer.caret);
        if (buffer.caret > 0) {
          buffer.text = buffer.text.slice(0,buffer.caret-1) + buffer.text.slice(buffer.caret);
          buffer.caret--;
        }
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
  const options = {mode:fallback?"auto":"cdp",advancedMode:true,showOverlay:false,
    startDelay:0,fixTypo:true,fixChance:35,fixPauseMs:400,
    cpm:1800,jitter:0,rest:false};
  return {
    send,options,buffer,sent,backspaces,
    get trustedKeydowns(){return trustedKeydowns;},
    get blocked(){return !!blockedWait;},
    release(){assert.ok(blockedWait);const fn=blockedWait;blockedWait=null;fn();},
    fireTrustedKey(key){
      document.dispatchEvent({type:"keydown",key,isTrusted:true,preventDefault(){},stopImmediatePropagation(){}});
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
  test("P1: trusted CDP Backspace never cancels Fix typo"+(fallback?" (auto fallback)":" (CDP only)"),async()=>{
    const h=makeCdpHarness({fallback});
    const result=h.send("AT_PAGE_START",{text:"a",options:h.options});
    assert.equal(result.ok,true);
    await h.waitForFinish();
    const status=h.send("AT_PAGE_STATUS").status;
    assert.equal(status.state,"done",status.error);
    assert.equal(status.index,1);
    assert.equal(h.buffer.text,"HELLOa");
    assert.deepEqual(h.sent,["s","a"]);
    assert.deepEqual(h.backspaces,[6]);
    assert.equal(h.trustedKeydowns,1);
  });
}

test("P1: human key still stops a pending CDP correction",async()=>{
  const h=makeCdpHarness({blockCorrection:true});
  h.send("AT_PAGE_START",{text:"a",options:h.options});
  await h.waitForCorrection();
  h.buffer.caret=0;
  h.fireTrustedKey("x");
  h.release();
  await h.waitForFinish();
  assert.equal(h.send("AT_PAGE_STATUS").status.state,"stopped");
  assert.equal(h.send("AT_PAGE_STATUS").status.index,0);
  assert.equal(h.buffer.text,"HELLOs");
  assert.deepEqual(h.backspaces,[]);
});

test("P1: a human Backspace without an in-flight CDP command is not exempt",async()=>{
  const h=makeCdpHarness({blockCorrection:true});
  h.send("AT_PAGE_START",{text:"a",options:h.options});
  await h.waitForCorrection();
  h.buffer.caret=0;
  h.fireTrustedKey("Backspace");
  h.release();
  await h.waitForFinish();
  assert.equal(h.send("AT_PAGE_STATUS").status.state,"stopped");
  assert.deepEqual(h.backspaces,[]);
});

function makePopupHarness() {
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
  let started=0,closed=false;
  const intervals=[];
  const storage = new Map([["autoTypeDraft:17","Saved"],["autoTypeDraft:99","Old"]]);
  const chrome = {
    runtime:{getManifest:()=>({permissions:[]})},
    commands:{getAll:async()=>[]},
    tabs:{
      query:async query=>query.active ? [{id:17,url:"https://docs.google.com/document/d/xyz/edit"}] : [{id:17}],
      sendMessage:async(id,payload)=>{
        if(payload.type==="AT_PAGE_START")started++;
        return {ok:true,status:{state:payload.type==="AT_PAGE_START"?"running":"idle",index:0,total:0}};
      }
    },
    scripting:{executeScript:async()=>{}},
    storage:{
      local:{get:async()=>({}),set:async()=>{}},
      session:{
        get:async key=>key===null?Object.fromEntries(storage):{[key]:storage.get(key)},
        set:async values=>{
          if(!canSave)throw new Error("QUOTA_BYTES quota exceeded");
          for(const [key,value] of Object.entries(values)) storage.set(key,value);
        },
        remove:async keys=>{for(const key of Array.isArray(keys)?keys:[keys])storage.delete(key);}
      }
    }
  };
  const handlers = new Map();
  const window={
    addEventListener:(type,fn)=>handlers.set(type,fn),
    close(){closed=true; handlers.get("pagehide")?.();handlers.get("unload")?.();}
  };
  vm.runInNewContext(read("iframe/popup.js"),{
    chrome,document:{getElementById:get,querySelectorAll:()=>[]},
    window,console,
    setTimeout,clearTimeout,
    setInterval:(fn,delay)=>{intervals.push({fn,delay});return intervals.length;},
    clearInterval(){}
  },{filename:"iframe/popup.js"});
  return {
    get,storage,
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
