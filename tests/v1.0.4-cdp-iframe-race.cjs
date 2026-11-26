"use strict";
// Exercises real content.js against a queued CDP Backspace: Stop, replace the
// Docs input iframe, deliver MutationObserver before any interval, then issue
// the trusted keydown in the *replacement* document.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const read = name => fs.readFileSync(name, "utf8");
const flush = async () => {
  for (let i=0; i<8; i++) await new Promise(resolve => setImmediate(resolve));
};
function target() {
  const handlers = new Map();
  return {
    addEventListener(name, cb) {
      handlers.set(name,[...(handlers.get(name)||[]),cb]);
    },
    removeEventListener(name, cb) {
      handlers.set(name,(handlers.get(name)||[]).filter(fn=>fn!==cb));
    },
    dispatchEvent(event) {
      for(const fn of [...(handlers.get(event.type)||[])]) {
        fn(event);
        if(event.stopped)break;
      }
      return !event.defaultPrevented;
    },
    count(name){return (handlers.get(name)||[]).length;}
  };
}
function event(type,key) {
  return {type,key,isTrusted:true,defaultPrevented:false,stopped:false,
    preventDefault(){this.defaultPrevented=true;},
    stopImmediatePropagation(){this.stopped=true;}};
}
function harness({edition="hybrid",keyboardLock=false,initialFrame=true}={}) {
  const document=target();
  document.documentElement={nodeType:1};
  const observers=new Set();
  let intervalCalls=0, listener;
  let queued=null;
  const buffer={text:"HELLO",caret:5};
  const keyEvents=[];
  let currentFrame=null;
  const frameSelector="iframe.docs-texteventtarget-iframe";
  const makeFrameDoc=()=>{
    const doc=target();
    doc.querySelector=()=>null;
    doc.body={dispatchEvent(){return true;},focus(){}};
    doc.activeElement=doc.body;
    return doc;
  };
  const makeFrame=()=>{
    const frame=target();
    frame.nodeType=1;
    frame.matches=selector=>selector===frameSelector;
    frame.querySelector=()=>null;
    frame.contentDocument=makeFrameDoc();
    frame.contentWindow={focus(){}};
    return frame;
  };
  if(initialFrame) currentFrame=makeFrame();
  document.querySelector=selector=>selector===frameSelector?currentFrame:null;
  class FakeMutationObserver {
    constructor(callback){this.callback=callback;this.connected=false;}
    observe(root,opts){
      assert.equal(root,document.documentElement);
      assert.equal(opts.subtree,true);
      assert.equal(opts.childList,true);
      this.connected=true;
      observers.add(this);
    }
    disconnect(){this.connected=false;observers.delete(this);}
  }
  const rand=Object.create(Math);
  rand.random=()=>0; // always pick a temporary typo and correct it
  let clock=0;
  const chrome={
    runtime:{
      getManifest:()=>({permissions:edition==="hybrid"?["debugger"]:[]}),
      onMessage:{addListener(fn){listener=fn;}},
      async sendMessage(message) {
        if(message.type==="AT_BG_INSERT") {
          const ch=message.char;
          buffer.text=buffer.text.slice(0,buffer.caret)+ch+buffer.text.slice(buffer.caret);
          buffer.caret+=ch.length;
        }
        if(message.type==="AT_BG_BACKSPACE") {
          return new Promise(resolve=>{
            queued=()=>{
              const e=event("keydown","Backspace");
              (currentFrame?.contentDocument||document).dispatchEvent(e);
              keyEvents.push(e);
              if(!e.defaultPrevented && buffer.caret>0) {
                buffer.text=buffer.text.slice(0,buffer.caret-1)+buffer.text.slice(buffer.caret);
                buffer.caret--;
              }
              (currentFrame?.contentDocument||document).dispatchEvent(event("keyup","Backspace"));
              resolve({ok:true});
            };
          });
        }
        if(message.type==="AT_BG_WAIT")clock+=message.ms;
        return {ok:true};
      }
    }
  };
  vm.runInNewContext(read(edition+"/content.js"),{
    chrome,document,window:{focus(){}},Math:rand,console:{error(){},warn(){}},
    performance:{now:()=>clock},setTimeout,clearTimeout,
    setInterval:()=>{intervalCalls++;return intervalCalls;},
    clearInterval:()=>{},MutationObserver:FakeMutationObserver,
    Event:class {},CustomEvent:class {constructor(type,options){this.type=type;this.detail=options?.detail;}}
  },{filename:edition+"/content.js"});
  const send=(type,params={})=>{
    let response;
    listener({type,...params},{},data=>{response=data;});
    return response;
  };
  const options={mode:"cdp",advancedMode:true,showOverlay:false,keyboardLock,
    startDelay:0,fixTypo:true,fixChance:35,fixPauseMs:400,
    cpm:1800,jitter:0,rest:false};
  const awaitQueued=async()=>{
    for(let i=0;i<60&&!queued;i++) await flush();
    assert.ok(queued,"CDP Backspace should be queued and not yet dispatched");
    assert.equal(buffer.text,"HELLOs");
  };
  const awaitFinish=async()=>{
    for(let i=0;i<75;i++){
      if(["stopped","done","error"].includes(send("AT_PAGE_STATUS").status.state)) {
        await flush();
        return;
      }
      await flush();
    }
    assert.fail("typing did not complete");
  };
  const replaceFrame=()=>{
    const old=currentFrame;
    currentFrame=makeFrame();
    const fresh=currentFrame.contentDocument;
    // Actual MutationObserver delivery happens on a microtask, ahead of
    // a later external CDP keydown task, not on the 1-second polling timer.
    queueMicrotask(()=>{
      const records=[{type:"childList",addedNodes:[currentFrame],
        removedNodes:old?[old]:[]}];
      for(const observer of [...observers]) if(observer.connected) observer.callback(records);
    });
    return fresh;
  };
  const navigateFrame=()=>{
    assert.ok(currentFrame);
    currentFrame.contentDocument=makeFrameDoc();
    // Same iframe element, new document: its load listener must re-guard it.
    currentFrame.dispatchEvent({type:"load"});
    return currentFrame.contentDocument;
  };
  return {send,buffer,keyEvents,options,awaitQueued,awaitFinish,
    get observerCount(){return observers.size;},
    get intervalCalls(){return intervalCalls;},
    get oldDoc(){return currentFrame?.contentDocument;},
    replaceFrame,navigateFrame,
    releaseBackspace(){
      assert.ok(queued);
      const fn=queued;queued=null;fn();
    }};
}
for(const keyboardLock of [false,true]) {
  test("P1: Stop -> replace input iframe -> late CDP Backspace before polling (keyboardLock="+keyboardLock+")",async()=>{
    const h=harness({keyboardLock});
    assert.equal(h.send("AT_PAGE_START",{text:"a",options:h.options}).ok,true);
    await h.awaitQueued();
    const old=h.oldDoc;
    assert.ok(old.count("keydown")>0);
    assert.equal(h.send("AT_PAGE_STOP").status.state,"stopped");
    const fresh=h.replaceFrame();
    assert.equal(fresh.count("keydown"),0,"old listener cannot intercept the new document");
    h.buffer.caret=3;
    await flush(); // MutationObserver, NO polling
    assert.ok(fresh.count("keydown")>0,"new document must be protected before the queued key arrives");
    h.releaseBackspace();
    await h.awaitFinish();
    assert.equal(h.buffer.text,"HELLOs","original L must survive delayed Backspace");
    assert.equal(h.send("AT_PAGE_STATUS").status.index,0);
    assert.equal(h.keyEvents.length,1);
    assert.equal(h.keyEvents[0].defaultPrevented,true);
    assert.equal(h.keyEvents[0].stopped,true);
    assert.equal(fresh.count("keydown"),0,"no listener leak");
    assert.equal(h.observerCount,0,"mutation observer must disconnect after completion");
  });
  test("P1: Stop -> navigate existing iframe -> late Backspace (keyboardLock="+keyboardLock+")",async()=>{
    const h=harness({keyboardLock});
    h.send("AT_PAGE_START",{text:"a",options:h.options});
    await h.awaitQueued();
    h.send("AT_PAGE_STOP");
    const fresh=h.navigateFrame();
    h.buffer.caret=3;
    assert.ok(fresh.count("keydown")>0,"load event must immediately install guard");
    h.releaseBackspace();
    await h.awaitFinish();
    assert.equal(h.buffer.text,"HELLOs");
    assert.equal(h.keyEvents[0].defaultPrevented,true);
    assert.equal(h.observerCount,0);
  });
  test("P1: replacement while correction is running stops safely (keyboardLock="+keyboardLock+")",async()=>{
    const h=harness({keyboardLock});
    h.send("AT_PAGE_START",{text:"a",options:h.options});
    await h.awaitQueued();
    const fresh=h.replaceFrame();
    h.buffer.caret=3;
    await flush();
    assert.equal(h.send("AT_PAGE_STATUS").status.state,"stopped");
    assert.ok(fresh.count("keydown")>0);
    h.releaseBackspace();
    await h.awaitFinish();
    assert.equal(h.buffer.text,"HELLOs");
    assert.equal(h.keyEvents[0].defaultPrevented,true);
  });
}
test("P1: legitimate queued CDP correction still works when the iframe remains unchanged",async()=>{
  const h=harness();
  h.send("AT_PAGE_START",{text:"a",options:h.options});
  await h.awaitQueued();
  h.releaseBackspace();
  await h.awaitFinish();
  assert.equal(h.buffer.text,"HELLOa");
  assert.equal(h.send("AT_PAGE_STATUS").status.state,"done");
  assert.equal(h.keyEvents[0].defaultPrevented,false);
  assert.equal(h.observerCount,0);
});
