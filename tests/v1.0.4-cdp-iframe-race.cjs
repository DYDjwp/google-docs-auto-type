"use strict";
// Regression for same-iframe navigation before load. The only reliable
// solution for a tab-focused CDP Backspace is to never dispatch one.
// Test all six state/keyboard-lock combinations before AND after load.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const read = file => fs.readFileSync(file, "utf8");
async function flush(times=8) {
  for (let i=0;i<times;i++) await new Promise(resolve=>setImmediate(resolve));
}
function target() {
  const listeners=new Map();
  return {
    addEventListener(type,fn){listeners.set(type,[...(listeners.get(type)||[]),fn]);},
    removeEventListener(type,fn){listeners.set(type,(listeners.get(type)||[]).filter(x=>x!==fn));},
    dispatchEvent(e){
      for(const fn of [...(listeners.get(e.type)||[])]){fn(e);if(e.stopped)break;}
      return !e.defaultPrevented;
    },
    count(type){return (listeners.get(type)||[]).length;}
  };
}
function harness({keyboardLock=false}={}) {
  const document=target();
  document.documentElement={nodeType:1};
  const observers=new Set();
  let onMessage, firstInsert=null, firstInsertQueued=false, loadEvents=0;
  const messages=[];
  const buffer={text:"HELLO",caret:5};
  const frame=target();
  frame.nodeType=1;
  frame.matches=selector=>selector==="iframe.docs-texteventtarget-iframe";
  frame.querySelector=()=>null;
  frame.contentWindow={focus(){}};
  function makeDoc(){
    const doc=target();
    doc.activeElement={focus(){}};
    doc.querySelector=()=>null;
    doc.body={focus(){},dispatchEvent(){}};
    return doc;
  }
  frame.contentDocument=makeDoc();
  document.querySelector=selector=>selector==="iframe.docs-texteventtarget-iframe"?frame:null;
  class MutationObserverMock {
    constructor(fn){this.fn=fn;}
    observe(root,options){assert.equal(options.subtree,true);observers.add(this);}
    disconnect(){observers.delete(this);}
  }
  let now=0;
  const rand=Object.create(Math);
  rand.random=()=>0;
  function insert(char) {
    buffer.text=buffer.text.slice(0,buffer.caret)+char+buffer.text.slice(buffer.caret);
    buffer.caret+=char.length;
  }
  const chrome={runtime:{
    getManifest:()=>({permissions:["debugger"]}),
    onMessage:{addListener(fn){onMessage=fn;}},
    async sendMessage(message){
      messages.push(message);
      if(message.type==="AT_BG_BACKSPACE") {
        // A real old-version command would be destructive in this scenario.
        throw Error("UNSAFE: issued tab-focused Backspace");
      }
      if(message.type==="AT_BG_INSERT"){
        if(!firstInsertQueued) {
          firstInsertQueued=true;
          return new Promise(resolve=>{firstInsert=()=>{insert(message.char);resolve({ok:true});};});
        }
        insert(message.char);
      }
      if(message.type==="AT_BG_WAIT") now+=message.ms;
      return {ok:true};
    }
  }};
  vm.runInNewContext(read("hybrid/content.js"),{
    document,chrome,window:{focus(){}},Math:rand,
    console:{warn(){},error(){},info(){}},
    performance:{now:()=>now},setTimeout,clearTimeout,
    setInterval:()=>1,clearInterval:()=>{},MutationObserver:MutationObserverMock,
    Event:class {},CustomEvent:class {constructor(type,opts){this.type=type;this.detail=opts?.detail;}}
  },{filename:"hybrid/content.js"});
  const send=(type,extra={})=>{
    let response;
    onMessage({type,...extra},{},r=>{response=r;});
    return response;
  };
  const options={mode:"cdp",advancedMode:true,showOverlay:false,keyboardLock,
    startDelay:0,fixTypo:true,fixChance:35,fixPauseMs:400,
    cpm:1800,jitter:0,rest:false};
  return {send,options,buffer,messages,
    get loadEvents(){return loadEvents;},
    get oldDoc(){return frame.contentDocument;},
    async awaitPendingInsert(){
      for(let i=0;i<50&&!firstInsert;i++)await flush(1);
      assert.ok(firstInsert,"expected queued CDP insert, not Backspace");
      assert.equal(buffer.text,"HELLO","no partial typo is ever inserted");
    },
    navigateBeforeLoad(){
      frame.contentDocument=makeDoc();
      return frame.contentDocument; // no DOM node mutation, no load event
    },
    triggerLoad(){frame.dispatchEvent({type:"load"});loadEvents++;},
    releaseInsert(){assert.ok(firstInsert);const fn=firstInsert;firstInsert=null;fn();},
    async finish(){
      for(let i=0;i<75;i++){
        if(["done","stopped","error"].includes(send("AT_PAGE_STATUS").status.state)){
          await flush();
          return;
        }
        await flush(1);
      }
      assert.fail("session did not finish");
    }
  };
}
function containsInOrder(text,source){
  let i=0;
  for(const letter of text)if(letter===source[i])i++;
  return i===source.length;
}
for(const loadBeforeCommand of [false,true]) {
  for(const keyboardLock of [false,true]){
    for(const state of ["running","stopped","paused"]){
      test("P1: same iframe new document before "+(loadBeforeCommand?"early":"late")+
        " load; "+state+", keyboardLock="+keyboardLock,async()=>{
        const h=harness({keyboardLock});
        h.send("AT_PAGE_START",{text:"a",options:h.options});
        await h.awaitPendingInsert();
        const old=h.oldDoc;
        assert.ok(old.count("keydown")>0);
        const fresh=h.navigateBeforeLoad();
        assert.equal(fresh.count("keydown"),0,
          "new document exists before load and before polling");
        h.buffer.caret=3;
        if(state==="stopped") h.send("AT_PAGE_STOP");
        if(state==="paused") h.send("AT_PAGE_PAUSE");
        if(state!=="running")
          assert.equal(h.send("AT_PAGE_STATUS").status.state,state);
        if(loadBeforeCommand) h.triggerLoad();
        else assert.equal(h.loadEvents,0,"load must not be fired yet");
        h.releaseInsert();
        if(state==="paused") h.send("AT_PAGE_STOP"); // allow cleanup
        await h.finish();
        if(!loadBeforeCommand) h.triggerLoad(); // load only AFTER command
        assert.equal(h.messages.filter(x=>x.type==="AT_BG_BACKSPACE").length,0);
        assert.ok(containsInOrder(h.buffer.text,"HELLO"),
          "all original characters must survive: "+h.buffer.text);
        assert.notEqual(h.buffer.text,"HELOs");
        assert.equal(h.buffer.text.length,6,
          "one non-destructive insertion, no Backspace");
      });
    }
  }
}
test("P1: source contains no CDP destructive Backspace sender in either edition",()=>{
  for(const edition of ["iframe","hybrid"]){
    const source=read(edition+"/content.js");
    assert.doesNotMatch(source,/sendToBackground\(\s*["']AT_BG_BACKSPACE/);
    assert.doesNotMatch(source,/cdpBackspaceExpected|cdpCorrectionFrame/);
  }
  assert.equal(read("iframe/content.js"),read("hybrid/content.js"));
});
for(const edition of ["iframe","hybrid"]){
  test("P1: legacy AT_BG_BACKSPACE command is rejected by the background worker ("+edition+")",async()=>{
    let replyListener=null;
    const dispatched=[];
    const event={addListener(){}};
    const chrome={
      runtime:{getManifest:()=>({permissions:edition==="hybrid"?["debugger"]:[]}),
        onMessage:{addListener(fn){replyListener=fn;}},onInstalled:event},
      debugger:{onDetach:event,attach:async()=>{},sendCommand:async(...args)=>dispatched.push(args)},
      tabs:{onRemoved:event,onUpdated:event,query:async()=>[],get:async()=>({url:"https://docs.google.com/document/d/demo/edit"})},
      storage:{session:{remove:async()=>{}}},
      scripting:{executeScript:async()=>{}},
      action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}},
      commands:{onCommand:event}
    };
    vm.runInNewContext(read(edition+"/background.js"),{
      chrome,console:{warn(){}},setTimeout,clearTimeout
    },{filename:edition+"/background.js"});
    assert.equal(typeof replyListener,"function");
    const result=await new Promise(resolve=>{
      const asynchronous=replyListener({type:"AT_BG_BACKSPACE"},
        {tab:{id:17,url:"https://docs.google.com/document/d/demo/edit"}},resolve);
      assert.equal(asynchronous,true);
    });
    assert.equal(result.ok,false);
    assert.match(result.error,/disabled to protect document content/);
    assert.deepEqual(dispatched,[]);
  });
}
