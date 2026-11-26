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
  test(edition+" production bridge offers legacy Backspace without claiming verified correction",()=>{
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
    assert.equal(reply.ok,true);
    assert.deepEqual(edits.map(e=>[e.type,e.key]),[["keydown","Backspace"],["keyup","Backspace"]]);
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

function modelBridge(edition,{ignoreTypo=false,ignoreRestore=false,available=true}={}){
  let request;
  const buffer={text:"HELLO WORLD",start:5,end:5};
  const edits=[], replies=new Map(), requests=new Map();
  const target={dispatchEvent:e=>{
    if(e.type!=="keypress")return;
    edits.push(e.key);
    if(ignoreTypo&&e.key==="s")return;
    buffer.text=buffer.text.slice(0,buffer.start)+e.key+buffer.text.slice(buffer.end);
    buffer.start+=e.key.length;buffer.end=buffer.start;
  }};
  const frame={contentDocument:{activeElement:target,body:{},querySelector:()=>target}};
  const document={querySelector:()=>frame,addEventListener:(type,fn)=>request=fn,
    dispatchEvent:e=>{const response=JSON.parse(e.detail);replies.set(response.id,response);requests.get(response.id)?.(response);}};
  const window=available?{_docs_annotate_canvas_by_ext:"existing-authorized-flag",location:{pathname:"/document/d/one/edit"},
    _docs_annotate_getAnnotatedText:async()=>({
      getText:()=>buffer.text,getSelection:()=>[{start:buffer.start,end:buffer.end}],
      setSelection:(start,end)=>{if(!ignoreRestore){buffer.start=start;buffer.end=end;}}
    })}:{};
  class E{constructor(type,opts){this.type=type;this.detail=opts?.detail;}}
  vm.runInNewContext(read(edition+"/main-bridge.js"),{document,window,Event:E,CustomEvent:E,setTimeout,clearTimeout});
  let id=0;
  return {buffer,edits,send(action,extra={}){const n=++id;return new Promise(resolve=>{
    requests.set(n,resolve);request({detail:JSON.stringify({id:n,action,sessionId:"task",...(action==="correct"?{selection:{start:5,end:5}}:{}),...extra})});
  });}};
}
for(const edition of ["iframe","hybrid"]){
  test(edition+" bridge restores selection with setSelection and readback",async()=>{
    const h=modelBridge(edition);
    h.buffer.start=h.buffer.end=1;
    const result=await h.send("restoreSelection",{selection:{start:5,end:5}});
    assert.equal(result.restored,true);
    assert.equal(h.buffer.start,5);
    assert.equal(h.buffer.text,"HELLO WORLD");
  });
  test(edition+" failed restore does not claim success",async()=>{
    const h=modelBridge(edition,{ignoreRestore:true});
    h.buffer.start=h.buffer.end=1;
    assert.equal((await h.send("restoreSelection",{selection:{start:5,end:5}})).restored,false);
    assert.equal(h.buffer.start,1);
  });
  test(edition+" model-confirmed correction replaces only temporary typo",async()=>{
    const h=modelBridge(edition);
    const result=await h.send("correct",{wrong:"s",correct:"a",delay:0});
    assert.equal(result.corrected,true);
    assert.equal(h.buffer.text,"HELLOa WORLD");
    assert.deepEqual(h.edits,["s","a"]);
    assert.deepEqual(result.selection,{start:6,end:6});
  });
  test(edition+" ignored temporary typo is never followed by a replacement",async()=>{
    const h=modelBridge(edition,{ignoreTypo:true});
    assert.equal((await h.send("correct",{wrong:"s",correct:"a",delay:0})).corrected,false);
    assert.equal(h.buffer.text,"HELLO WORLD");
    assert.deepEqual(h.edits,["s"]);
  });
  test(edition+" cancel during correction delay prevents replacement",async()=>{
    const h=modelBridge(edition);
    const pending=h.send("correct",{wrong:"s",correct:"a",delay:150});
    await flush();
    assert.equal(h.buffer.text,"HELLOs WORLD");
    await h.send("cancelOperation");
    assert.equal((await pending).corrected,false);
    assert.deepEqual(h.edits,["s"]);
    assert.equal(h.buffer.text,"HELLOs WORLD");
  });
  test(edition+" unavailable model skips correction before inserting typo",async()=>{
    const h=modelBridge(edition,{available:false});
    assert.equal((await h.send("correct",{wrong:"s",correct:"a",delay:0})).skipped,true);
    assert.deepEqual(h.edits,[]);
  });
}

for(const edition of ["iframe","hybrid"]){
  test(edition+" correction refuses a different starting selection before inserting",async()=>{
    const h=modelBridge(edition);
    h.buffer.start=h.buffer.end=1;
    assert.equal((await h.send("correct",{wrong:"s",correct:"a",delay:0})).corrected,false);
    assert.equal(h.buffer.text,"HELLO WORLD");
    assert.deepEqual(h.edits,[]);
  });
}

test("dev annotation hook runs in MAIN at document_start without replacing an existing flag",()=>{
  for(const edition of ["iframe","hybrid"]){
    const manifest=JSON.parse(read(edition+"/manifest.json"));
    const early=manifest.content_scripts[0];
    assert.equal(early.run_at,"document_start");
    assert.equal(early.world,"MAIN");
    assert.equal(early.all_frames,false);
    assert.deepEqual(early.js,["annotated-early.js"]);
    const window={_docs_annotate_canvas_by_ext:"existing-authorization"};
    vm.runInNewContext(read(edition+"/annotated-early.js"),{window});
    assert.equal(window._docs_annotate_canvas_by_ext,"existing-authorization");
  }
});
