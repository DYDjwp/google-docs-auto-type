"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const read = path => fs.readFileSync(path,"utf8");
const flush = async () => {for(let i=0;i<12;i++) await new Promise(r=>setImmediate(r));};
function worker({holdAttach=false, holdValidation=false}={}) {
  let url="https://docs.google.com/document/d/one/edit", active=true;
  let listener, updated, releaseAttach, releaseValidation, reads=0;
  const commands=[];
  const event={addListener(){}};
  const chrome={
    runtime:{getManifest:()=>({permissions:["debugger"]}),onInstalled:event,onMessage:{addListener:f=>listener=f}},
    tabs:{get:async()=>({url}),query:async()=>[],onRemoved:event,onUpdated:{addListener:f=>updated=f},
      sendMessage:async(id,msg,options)=>{
        assert.equal(options.documentId,"doc-one");
        assert.equal(msg.sessionId,"task-one");
        reads++;
        if(holdValidation && reads===2) await new Promise(r=>releaseValidation=r);
        return {ok:active};
      }},
    debugger:{onDetach:event,attach:async()=>{if(holdAttach) await new Promise(r=>releaseAttach=r);},
      detach:async()=>{},sendCommand:async(target,command,payload)=>commands.push({command,payload})},
    storage:{session:{get:async()=>({}),remove:async()=>{}}},
    commands:{onCommand:event}
  };
  vm.runInNewContext(read("hybrid/background.js"),{chrome,console,setTimeout,clearTimeout});
  const sender={tab:{id:17,url},url,frameId:0,documentId:"doc-one"};
  return {commands,
    send(type,extra={}){return new Promise(resolve=>listener({type,sessionId:"task-one",...extra},sender,resolve));},
    navigate(){url="https://docs.google.com/document/d/two/edit";active=false;updated(17,{status:"loading",url});},
    stop(){active=false;},
    releaseAttach(){assert.ok(releaseAttach);releaseAttach();},
    releaseValidation(){assert.ok(releaseValidation);releaseValidation();}
  };
}
test("normal CDP insert validates exact document and session before dispatch",async()=>{
  const h=worker();
  assert.equal((await h.send("AT_BG_INSERT",{char:"a"})).ok,true);
  assert.equal(h.commands.length,1);
  assert.equal(h.commands[0].payload.text,"a");
  assert.equal((await h.send("AT_BG_DETACH")).ok,true);
});
test("navigation while debugger attaches never sends a character",async()=>{
  const h=worker({holdAttach:true});
  const p=h.send("AT_BG_INSERT",{char:"a"});
  await flush();
  h.navigate();h.releaseAttach();
  assert.equal((await p).ok,false);
  assert.equal(h.commands.length,0);
});
test("Stop during final session validation prevents CDP insert",async()=>{
  const h=worker({holdValidation:true});
  const p=h.send("AT_BG_INSERT",{char:"a"});
  await flush();h.stop();h.releaseValidation();
  assert.equal((await p).ok,false);
  assert.equal(h.commands.length,0);
});
test("legacy CDP inserts without session identity fail closed",async()=>{
  const h=worker();
  assert.equal((await h.send("AT_BG_INSERT",{char:"a",sessionId:undefined})).ok,false);
  assert.equal(h.commands.length,0);
});
for(const edition of ["iframe","hybrid"]){
  test(edition+" production bridge does not advertise verified correction and rejects Backspace",()=>{
    let request, reply;const edits=[];
    const target={dispatchEvent:e=>edits.push(e)};
    const document={
      querySelector:()=>({contentDocument:{activeElement:target,body:{}}}),
      addEventListener:(type,fn)=>request=fn,
      dispatchEvent:e=>reply=JSON.parse(e.detail)
    };
    class E {constructor(type,opts){this.type=type;this.detail=opts?.detail;}}
    vm.runInNewContext(read(edition+"/main-bridge.js"),{document,window:{},Event:E,CustomEvent:E});
    request({detail:JSON.stringify({id:1,action:"probe"})});
    assert.equal(reply.ok,true);
    assert.equal(reply.verifiedCorrection,false);
    request({detail:JSON.stringify({id:2,action:"backspace"})});
    assert.equal(reply.ok,false);
    assert.equal(edits.length,0);
  });
}

for(const edition of ["iframe","hybrid"]){
  test(edition+" logical Selection adapter reads offsets without text or mutation",async()=>{
    let request, reply;
    const document={addEventListener:(type,fn)=>request=fn,
      dispatchEvent:e=>reply=JSON.parse(e.detail)};
    const window={_docs_annotate_canvas_by_ext:"existing-flag",
      _docs_annotate_getAnnotatedText:async flag=>{
        assert.equal(flag,"existing-flag");
        return {getSelection:()=>[{anchor:9,focus:3}],
          getText(){throw Error("must not read text");},setSelection(){throw Error("must not move caret");}};
      }};
    class E {constructor(type,opts){this.type=type;this.detail=opts?.detail;}}
    vm.runInNewContext(read(edition+"/main-bridge.js"),{document,window,Event:E,CustomEvent:E});
    request({detail:JSON.stringify({id:7,action:"selection"})});
    await flush();
    assert.deepEqual(reply,{id:7,ok:true,selection:{start:3,end:9}});
  });
}
