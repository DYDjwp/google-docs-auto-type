"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const html = fs.readFileSync('docs/uninstall.html','utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!script) throw new Error('Missing inline uninstall handler');
const modUrl=pathToFileURL(path.resolve('docs/uninstall-redaction.mjs')).href;
const getPrivacy=()=>import(modUrl);

test('local redaction bundle is self-hosted and pinned to 1.6.1',()=>{
  const readme=fs.readFileSync('docs/vendor/README.md','utf8');
  assert.match(readme,/flare-redact.*1\.6\.1/s);
  assert.ok(fs.statSync('docs/vendor/flare-redact-1.6.1.mjs').size>5000);
  assert.match(fs.readFileSync('docs/uninstall-redaction.mjs','utf8'),/import \{redact\} from '\.\/vendor\/flare-redact-1\.6\.1\.mjs'/);
  assert.doesNotMatch(html,/https:\/\/cdn\.|https:\/\/esm\.sh/);
  assert.match(script,/await import\('\.\/uninstall-redaction\.mjs'\)/);
});
test('PII is redacted locally before transmission without modifying input',async()=>{
  const {redactComment}=await getPrivacy();
  const original='Contact me at alice@example.com or +1 (415) 555-0123. Card: 4242 4242 4242 4242. Typing stopped after 5 chars.';
  const result=redactComment(original);
  assert.equal(typeof result.comment,'string');
  assert.equal(result.masked,true);
  assert.doesNotMatch(result.comment,/alice@example\.com|4242 4242 4242 4242/);
  assert.match(result.comment,/Typing stopped after 5 chars/);
  assert.equal(original.includes('alice@example.com'),true);
});
test('Redactor does not alter normal bug descriptions and limits output length',async()=>{
  const {redactComment}=await getPrivacy();
  const input='The typing cursor jumps after the third newline.';
  assert.equal(redactComment(input).comment,input);
  assert.equal(redactComment(input).masked,false);
  const many = 'test '.repeat(300);
  assert.ok(redactComment(many).comment.length<=1500);
  assert.throws(()=>redactComment('x'.repeat(1501)),/Invalid feedback comment length/);
  assert.throws(()=>redactComment(null),/Invalid feedback/);
});
function makeHarness({loadFails=false,fetchFails=false,personal='Contact alice@example.com', reasons=['bugs']}={}) {
  const nodes=new Map(),listeners={};
  const get=id=>{
    if(nodes.has(id))return nodes.get(id);
    const node={value:'',textContent:'',innerHTML:id==='submit'?'Send feedback':'',disabled:false,
      hidden:false,checked:false,events:{},focus(){this.focused=true;},
      reset(){this.didReset=true;},
      addEventListener(type,callback){this.events[type]=callback;}};
    nodes.set(id,node);return node;
  };
  get('comment').value=personal;
  get('submit').innerHTML='Send feedback';
  const elements={reason:reasons};
  const form=get('feedback');
  let requests=[];
  const context={
    document:{getElementById:get},
    crypto:{randomUUID:()=> '0d15b9a1-0984-4d6e-bd2e-d235b76f6c48'},
    FormData:class {
      getAll(k){return k==='reason'?elements.reason:[];}
      get(k){return k==='website'?'':null;}
    },
    URLSearchParams,
    AbortSignal,
    fetch:async (url,options)=>{
      requests.push({url,options});
      if(fetchFails)throw Error('network failure');
      return {type:'opaque'};
    }
  };
  const mockModule={redactComment: raw=>{
    if(loadFails)throw Error('privacy module unavailable');
    // Match the known PII sample by delegating to a simulated local redactor.
    return {comment:raw.replaceAll('alice@example.com','[REDACTED:email]'),masked:raw.includes('alice@example.com')};
  }};
  const replaced=script.replace("await import('./uninstall-redaction.mjs')","await loadLocalPrivacyModule()");
  assert.notEqual(replaced,script);
  context.loadLocalPrivacyModule=async()=> {
    if(loadFails)throw Error('failed to load local module');
    return mockModule;
  };
  vm.runInNewContext(replaced,context);
  return {
    form, get, requests, mockModule,
    async submit(){
      await form.events.submit({preventDefault(){this.prevented=true;}});
    }
  };
}
test('POST includes redacted comment; no raw personal data reaches fetch',async()=>{
  const h=makeHarness();
  await h.submit();
  assert.equal(h.requests.length,1);
  const body=h.requests[0].options.body;
  assert.equal(body.get('comment'),'Contact [REDACTED:email]');
  assert.doesNotMatch(body.toString(),/alice%40example\.com/);
  assert.equal(h.requests[0].options.method,'POST');
  assert.equal(h.requests[0].options.mode,'no-cors');
  assert.equal(h.requests[0].options.credentials,'omit');
  assert.equal(h.get('comment').value,'Contact alice@example.com');
  assert.equal(h.get('done').hidden,false);
});
test('Redactor failure prevents any request and preserves original text for retry',async()=>{
  const h=makeHarness({loadFails:true});
  await h.submit();
  assert.equal(h.requests.length,0);
  assert.equal(h.get('comment').value,'Contact alice@example.com');
  assert.match(h.get('status').textContent,/could not be sent safely/);
  assert.equal(h.get('submit').disabled,false);
});
test('Network failure preserves original comment; Skip sends no data',async()=>{
  const h=makeHarness({fetchFails:true});
  await h.submit();
  assert.equal(h.requests.length,1);
  assert.equal(h.get('comment').value,'Contact alice@example.com');
  assert.match(h.get('status').textContent,/could not be sent safely/);
  h.get('skip').events.click();
  assert.equal(h.requests.length,1);
});
test('User cannot submit a blank form or overlength text',async()=>{
  const a=makeHarness({personal:' ',reasons:[]});await a.submit();assert.equal(a.requests.length,0);
  const b=makeHarness({personal:'x'.repeat(1501),reasons:['bugs']});
  await b.submit();assert.equal(b.requests.length,0);
});
