"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const read = name => fs.readFileSync(name,"utf8");
const flush = async () => {
  for (let i=0;i<8;i++) await new Promise(resolve=>setImmediate(resolve));
};

function harness(edition,{blockWait=false,blockDetach=false,failInsert=false}={}) {
  const handlers=new Map();
  let onMessage, releaseWait, releaseDetach, waitEntered=false, detachEntered=false;
  let waitGated=false, detachGated=false, clock=0;
  const calls=[];
  class CustomEvent {
    constructor(type,options={}){this.type=type;this.detail=options.detail;}
  }
  const document={
    addEventListener(type,fn){handlers.set(type,[...(handlers.get(type)||[]),fn]);},
    removeEventListener(type,fn){
      handlers.set(type,(handlers.get(type)||[]).filter(x=>x!==fn));
    },
    querySelector:()=>null,
    dispatchEvent(event) {
      if(event.type==="__auto_type_main_request_v3__") {
        const message=JSON.parse(event.detail);
        queueMicrotask(()=>this.dispatchEvent(new CustomEvent("__auto_type_main_response_v3__",{
          detail:JSON.stringify({id:message.id,ok:true})
        })));
      }
      for(const fn of [...(handlers.get(event.type)||[])]) fn(event);
      return true;
    }
  };
  const chrome={runtime:{
    getManifest:()=>({permissions:edition==="hybrid"?["debugger"]:[]}),
    onMessage:{addListener(fn){onMessage=fn;}},
    async sendMessage(message){
      calls.push(message.type);
      if(message.type==="AT_BG_WAIT" && blockWait && !waitGated) {
        waitGated=true;waitEntered=true;
        return new Promise(resolve=>{releaseWait=()=>{clock+=message.ms;resolve({ok:true});};});
      }
      if(message.type==="AT_BG_DETACH" && blockDetach && !detachGated){
        detachGated=true;detachEntered=true;
        return new Promise(resolve=>{releaseDetach=()=>resolve({ok:true});});
      }
      if(message.type==="AT_BG_WAIT") clock+=message.ms;
      if(message.type==="AT_BG_INSERT" && failInsert) throw Error("synthetic typing failure");
      return {ok:true};
    }
  }};
  vm.runInNewContext(read(edition+"/content.js"),{
    document,chrome,window:{focus(){}},performance:{now:()=>clock},
    console:{warn(){},info(){},error(){}},
    Math,setTimeout,clearTimeout,setInterval:()=>1,clearInterval(){},
    CustomEvent,Event:CustomEvent
  },{filename:edition+"/content.js"});
  const send=(type,data={})=>{
    let response;
    onMessage({type,...data},{},value=>{response=value;});
    return response;
  };
  const status=()=>send("AT_PAGE_STATUS").status;
  const options={advancedMode:true,showOverlay:false,
    mode:edition==="hybrid"?"cdp":"iframe",startDelay:blockWait?1:0,
    cpm:1800,jitter:0,rest:false,typo:false,fixTypo:false};
  const until=async(condition,message)=>{
    for(let i=0;i<75;i++){if(condition())return;await flush();}
    assert.fail(message);
  };
  return {
    send,status,options,calls,
    get waitEntered(){return waitEntered;},
    get detachEntered(){return detachEntered;},
    releaseWait(){assert.ok(releaseWait);releaseWait();releaseWait=null;},
    releaseDetach(){assert.ok(releaseDetach);releaseDetach();releaseDetach=null;},
    until
  };
}
for(const edition of ["iframe","hybrid"]) {
  test(edition+": Stop acknowledges stopped before background wait resolves, but never marks ready",async()=>{
    const h=harness(edition,{blockWait:true,blockDetach:edition==="hybrid"});
    assert.equal(h.status().readyToStart,true,"idle is ready");
    assert.equal(h.send("AT_PAGE_START",{text:"hello",options:h.options}).ok,true);
    await h.until(()=>h.waitEntered,"task must have an in-flight wait");
    assert.equal(h.status().readyToStart,false);
    assert.equal(h.send("AT_PAGE_STOP").status.state,"stopped");
    assert.equal(h.status().readyToStart,false,"Stop acknowledgement cannot imply cleanup is complete");
    const early=h.send("AT_PAGE_START",{text:"replacement",options:h.options});
    assert.equal(early.ok,false);
    assert.match(early.error,/still cleaning up/);
    h.releaseWait();
    if(edition==="hybrid"){
      await h.until(()=>h.detachEntered,"CDP detach should start after wait ends");
      assert.equal(h.status().readyToStart,false,"detach must finish before another Start");
      assert.equal(h.send("AT_PAGE_START",{text:"replacement",options:h.options}).ok,false);
      h.releaseDetach();
    }
    await h.until(()=>h.status().readyToStart,"cleanup must finalize");
    assert.equal(h.status().state,"stopped");
    assert.equal(h.send("AT_PAGE_START",{text:"replacement",options:h.options}).ok,true);
  });
}
for(const ending of ["done","error"]) {
  test("hybrid: "+ending+" cannot start another task until CDP detach finishes",async()=>{
    const h=harness("hybrid",{blockDetach:true,failInsert:ending==="error"});
    h.send("AT_PAGE_START",{text:"x",options:h.options});
    await h.until(()=>h.detachEntered,"final cleanup must reach detach");
    assert.equal(h.status().state,ending);
    assert.equal(h.status().readyToStart,false);
    assert.equal(h.send("AT_PAGE_START",{text:"another",options:h.options}).ok,false);
    h.releaseDetach();
    await h.until(()=>h.status().readyToStart,"ready after detach");
    assert.equal(h.status().state,ending);
    if(ending==="error") assert.match(h.status().error,/synthetic typing failure/);
    assert.equal(h.send("AT_PAGE_START",{text:"another",options:h.options}).ok,true);
  });
}
test("the content-script readiness contract is identical in both editions",()=>{
  assert.equal(read("iframe/content.js"),read("hybrid/content.js"));
  assert.equal(read("iframe/popup.js"),read("hybrid/popup.js"));
  for(const edition of ["iframe","hybrid"]) {
    assert.match(read(edition+"/content.js"),/readyToStart: job\.finalized/);
    assert.match(read(edition+"/popup.js"),/currentReadyToStart = status\.readyToStart === true/);
  }
});
