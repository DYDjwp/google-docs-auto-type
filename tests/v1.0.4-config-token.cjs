"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const read = path => fs.readFileSync(path,"utf8");
const plain = value => JSON.parse(JSON.stringify(value));
const flush = async () => {
  for(let i=0;i<8;i++) await new Promise(resolve=>setImmediate(resolve));
};
function codec(edition) {
  const context = vm.createContext({});
  vm.runInContext(read(edition+"/config-codec.js"),context);
  return context.AutoTypeConfig;
}
const c = codec("iframe");
const sample = {advancedMode:true,cpm:450,jitter:20,keyboardLock:true,mouseLock:true};
const common = {...c.defaults, ...sample};
const dense = {
  speed:"fast",advancedMode:true,cpm:1800,jitter:90,punctuationMs:3000,newlineMs:5000,
  rest:true,restMinChars:5,restMaxChars:10000,restMinMs:0,restMaxMs:60000,
  microChance:100,microMinMs:0,microMaxMs:10000,startDelay:15,mode:"cdp",
  enterStrategy:"both",typo:true,fixTypo:true,deepRest:true,typoChance:35,fixChance:35,
  fixPauseMs:3000,deepRestAt:"sentence",deepChance:100,deepMinMs:0,
  deepMaxMs:120000,keyboardLock:true,mouseLock:true,showOverlay:false
};
test("AT1 codec is identical in both editions and loaded before popup",()=>{
  assert.equal(read("iframe/config-codec.js"),read("hybrid/config-codec.js"));
  for(const edition of ["iframe","hybrid"]){
    const html=read(edition+"/popup.html");
    assert.ok(html.indexOf('src="config-codec.js"')>=0);
    assert.ok(html.indexOf('src="config-codec.js"')<html.indexOf('src="popup.js"'));
    const popup=read(edition+"/popup.js");
    const defaults=vm.runInNewContext(popup.slice(0,popup.indexOf("const PRESETS"))+"\nDEFAULTS;");
    assert.deepEqual(plain(c.defaults),plain(defaults),"AT1 defaults must match the initial schema");
  }
  assert.equal(Object.keys(c.defaults).length,30);
});
test("AT1 token length and sparse/dense selection",()=>{
  const a=c.encode(c.defaults), b=c.encode(common), d=c.encode(dense);
  console.log("AT1 token samples:", JSON.stringify({
    default:{length:a.length,token:a},
    common:{length:b.length,token:b},
    dense:{length:d.length,token:d},
    iframeDefault:{length:c.encode({...c.defaults,mode:"iframe"}).length,token:c.encode({...c.defaults,mode:"iframe"})}
  }));
  assert.equal(a.length,8);
  assert.ok(b.length<=24);
  assert.ok(d.length<=55);
  assert.equal(Buffer.from(a.slice(4),"base64url")[0]>>7,0);
  assert.equal(Buffer.from(d.slice(4),"base64url")[0]>>7,1);
  for(const settings of [c.defaults,common,dense]) {
    const token=c.encode(settings);
    assert.deepEqual(plain(c.decode(token)),plain(settings));
    assert.equal(c.encode(c.decode(token)),token);
    assert.equal(codec("hybrid").encode(settings),token);
  }
});
test("AT1 preserves arbitrary valid fractions exactly rather than rounding",()=>{
  const settings={...dense,cpm:123.456,jitter:18.123456789,typoChance:1.75,
    startDelay:0.375,restMinMs:123.4567890123,deepMaxMs:99999.999999999,
    microChance:Number.MIN_VALUE};
  const token=c.encode(settings);
  assert.deepEqual(plain(c.decode(token)),settings);
  assert.ok(token.length<=c.maxToken);
});
test("AT1 rejects invalid field types, ranges and non-finite values",()=>{
  for(const v of [{cpm:29},{cpm:1801},{jitter:Infinity},{jitter:NaN},{startDelay:-1},
    {typoChance:35.01},{mode:"whatever"},{keyboardLock:1},{rest:"false"},{cpm:"300"},
    {showOverlay:null},{deepMaxMs:120001}]) assert.throws(()=>c.encode(v),/Invalid setting/);
  assert.throws(()=>c.encode(null),/Invalid configuration/);
});
test("AT1 ignores unknown fields and never exports text or document information",()=>{
  const token=c.encode({...common,text:"private draft",url:"https://docs.google.com/document/d/secret",tabId:42,foo:"private"});
  assert.equal(token,c.encode(common));
  assert.deepEqual(plain(c.decode(token)),plain(common));
});
test("AT1 rejects unsupported versions, malformed base64, truncation, and checksum errors",()=>{
  const token=c.encode(common);
  for(const bad of ["", "AT2."+token.slice(4), "AT1.!", token+"=", token.slice(0,-1),
    token+"A", token.slice(0,5)+(token[5]==="A"?"B":"A")+token.slice(6),
    "AT1."+"A".repeat(600),token.slice(0,6)+" "+token.slice(6)]) assert.throws(()=>c.decode(bad));
  assert.deepEqual(plain(c.decode(" \n"+token+"\r\n")),plain(common));
  assert.throws(()=>c.decode("AT2.AAAA"),/Unsupported configuration version/);
});
// Valid CRC on corrupt payloads must not bypass semantic checks.
function seal(bytes) {
  let crc=0xffff;
  for(const byte of bytes){
    crc^=byte<<8;
    for(let i=0;i<8;i++)crc=((crc&0x8000)?(crc<<1)^0x1021:crc<<1)&0xffff;
  }
  return "AT1."+Buffer.from([...bytes,crc>>8,crc&255]).toString("base64url");
}
test("AT1 rejects malformed values even with a recalculated checksum",()=>{
  // sparse count 1, field 31 (not present); count 31; non-zero padding;
  // dense speed=3 (reserved); trailing payload byte; truncated dense.
  for(const bytes of [[0x07,0xe0],[0x7c],[0x01],[0xe0],[0,0],[0x80]])
    assert.throws(()=>c.decode(seal(bytes)));
});
test("AT1 round trips 250 deterministic mixed settings",()=>{
  let seed=123456789;
  const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
  for(let i=0;i<250;i++){
    const v={...c.defaults};
    for(const [key,value] of Object.entries(v)){
      if(rand()<0.5) continue;
      if(typeof value==="boolean")v[key]=!value;
      else if(typeof value==="number"){
        const lo=Math.min(value,dense[key]),hi=Math.max(value,dense[key]);
        v[key]=lo+(hi-lo)*rand();
      }else v[key]=dense[key];
    }
    const token=c.encode(v);
    assert.ok(token.length<=c.maxToken);
    assert.deepEqual(plain(c.decode(token)),v);
  }
});
function popupHarness(edition,{initial={},failWrite=false,failClipboard=false,holdFirstWrite=false}={}){
  class Element{
    constructor(){this.value="";this.textContent="";this.checked=false;this.disabled=false;this.hidden=false;
      this.style={};this.events=new Map();this.classList={toggle(){},add(){},remove(){}};}
    addEventListener(type,fn){this.events.set(type,[...(this.events.get(type)||[]),fn]);}
    setAttribute(){}
    focus(){this.focused=true;}
    select(){this.selected=true;}
    async fire(type){return Promise.all((this.events.get(type)||[]).map(fn=>fn({type})));}
  }
  const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  let saved={...initial},writes=[],clip=[],writeCount=0,releaseFirst;
  const gate=holdFirstWrite?new Promise(resolve=>releaseFirst=resolve):Promise.resolve();
  const chrome={
    runtime:{getManifest:()=>({permissions:edition==="hybrid"?["debugger"]:[],version:"1.0.4-dev"})},
    commands:{getAll:async()=>[]},
    storage:{
      local:{
        get:async()=>({autoTypeSettings:saved}),
        set:async data=>{
          const n=++writeCount;
          if(n===1)await gate;
          if(failWrite)throw new Error("storage unavailable");
          saved=plain(data.autoTypeSettings);writes.push(saved);
        }
      },
      session:{get:async key=>({[key]:"Draft to keep"}), set:async()=>{},remove:async()=>{}}
    },
    tabs:{query:async()=>[{id:17,url:"https://docs.google.com/document/d/example/edit"}],
      sendMessage:async()=>({ok:true,status:{state:"idle"}})}
  };
  const window={addEventListener(){},close(){}};
  vm.runInNewContext(read(edition+"/config-codec.js")+"\n"+read(edition+"/popup.js"),{
    chrome,window,document:{getElementById:get,querySelectorAll:()=>[]},
    navigator:{clipboard:{writeText:async value=>{if(failClipboard)throw new Error("denied");clip.push(value);}}},
    console,setTimeout,clearTimeout,setInterval:()=>1,clearInterval(){}
  });
  return {get,writes,clip,get saved(){return saved;},releaseFirst,
    async import(token){get("configToken").value=token;await get("importConfig").fire("click");await flush();},
    async export(){await get("exportConfig").fire("click");await flush();}};
}
for(const edition of ["iframe","hybrid"]){
  test(edition+": import saves all settings, adjusts unsupported input mode and keeps draft",async()=>{
    const h=popupHarness(edition);
    await flush();
    await h.import(c.encode(common));
    const expected={...common,mode:edition==="iframe"?"iframe":"auto"};
    assert.deepEqual(h.saved,expected);
    assert.equal(h.get("cpm").value,450);
    assert.equal(h.get("keyboardLock").checked,true);
    assert.equal(h.get("text").value,"Draft to keep");
    assert.equal(h.get("advancedMode").checked,true);
    assert.match(h.get("configStatus").textContent,/imported/i);
    if(edition==="iframe")assert.match(h.get("configStatus").textContent,/adjusted to iframe/);
    await h.export();
    assert.equal(h.clip[0],c.encode(expected));
    assert.equal(h.get("configToken").value,h.clip[0]);
  });
  test(edition+": invalid token leaves both UI and storage unchanged",async()=>{
    const h=popupHarness(edition,{initial:{cpm:420,advancedMode:true}});
    await flush();
    await h.import("AT1.bad");
    assert.equal(h.writes.length,0);
    assert.equal(h.get("cpm").value,420);
    assert.match(h.get("configStatus").textContent,/Invalid|damaged/);
  });
  test(edition+": failed storage write leaves prior configuration intact",async()=>{
    const h=popupHarness(edition,{initial:{cpm:420,advancedMode:true},failWrite:true});
    await flush();
    await h.import(c.encode(common));
    assert.equal(h.writes.length,0);
    assert.equal(h.saved.cpm,420);
    assert.equal(h.get("cpm").value,420);
    assert.match(h.get("configStatus").textContent,/Previous settings kept/);
    assert.equal(h.get("importConfig").disabled,false);
  });
  test(edition+": clipboard denial leaves visible selected token for manual copying",async()=>{
    const h=popupHarness(edition,{failClipboard:true});
    await flush();
    await h.export();
    assert.match(h.get("configToken").value,/^AT1\./);
    assert.equal(h.get("configToken").selected,true);
    assert.match(h.get("configStatus").textContent,/Copy it manually/);
  });
  test(edition+": slow previous edit cannot overwrite newer imported settings",async()=>{
    const h=popupHarness(edition,{holdFirstWrite:true});
    await flush();
    h.get("cpm").value="420";
    const edit=h.get("cpm").fire("change");
    await flush();
    const importing=h.import(c.encode(common));
    await flush();
    assert.equal(h.get("importConfig").disabled,true);
    assert.equal(h.get("start").disabled,true);
    h.releaseFirst();
    await Promise.all([edit,importing]);
    assert.equal(h.writes.length,2);
    assert.equal(h.saved.cpm,450);
    assert.equal(h.get("cpm").value,450);
  });
}
