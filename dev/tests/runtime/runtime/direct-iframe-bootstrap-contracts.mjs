import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createEnvelopePeer,GATEWAY_PROTOCOL} from '../../../../src/runtime/direct-iframe-protocol.js';

const filename=fileURLToPath(new URL('../../../../src/runtime/direct-iframe-bootstrap.js',import.meta.url));
// Preserve source offsets so Node's native coverage includes the actual fixed
// bootstrap, not a separately maintained test implementation of its adapters.
const source=fs.readFileSync(filename,'utf8').replace(/^export /gm,'       ');
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
class DetailEvent extends Event {constructor(type,values={}){super(type);Object.assign(this,values)}}
class Element extends EventTarget {
  constructor(tag='DIV',attributes={}){super();this.tagName=tag;this.attrs=new Map(Object.entries(attributes));this.children=[];this.textContent='';}
  get attributes(){return [...this.attrs].map(([name,value])=>({name,value}))} get type(){return this.getAttribute('type')||''}
  get src(){return this.getAttribute('src')}set src(value){this.setAttribute('src',value)}
  get enctype(){return this.getAttribute('enctype')||'application/x-www-form-urlencoded'}
  getAttribute(key){return this.attrs.get(key)??null}setAttribute(key,value){this.attrs.set(key,String(value))}hasAttribute(key){return this.attrs.has(key)}
  append(...nodes){this.children.push(...nodes)}
  replaceWith(node){this.replaced=node;if(node instanceof Element&&node.tagName==='SCRIPT')queueMicrotask(()=>node.src?.includes('fail')?node.onerror?.():node.onload?.());}
}
function fixture(t,{initialize=true,maxBodyBytes=128,resources=[],documentHtml,handle,renderScripts=[]}={}){
  const events=new EventTarget();const received=[];const diagnostics=[];const parent={};const body=new Element('BODY');
  const nativeHistory={};const Form=class extends Element {};
  const doc={body,title:'fixture',querySelector:()=>body.children.find(node=>node?.hasAttribute?.('data-nacelle-gateway-error')),
    createComment:()=>new Element('COMMENT'),dispatchEvent:events.dispatchEvent.bind(events),
    createElement(tag){if(tag==='template')return {innerHTML:'',content:{querySelectorAll:()=>renderScripts}};return new Element(tag.toUpperCase())}};
  const port={closed:false,onmessage:null,close(){this.closed=true},start(){},postMessage(message){received.push(message);if(peer.receive(message))handleMessage(message)}};
  let peer=createEnvelopePeer({sessionId:'session',nonce:'a'.repeat(48),send:data=>queueMicrotask(()=>port.onmessage?.({data})),onError:error=>{throw error}});
  const reply=(type,data)=>peer.send(type,data);
  const encode=value=>new TextEncoder().encode(value);
  const handleMessage=message=>{
    if(handle?.(message,reply)===true)return;
    const p=message.payload;
    if(message.type==='http-request'){
      if(p.url.includes('/hang'))return;
      if(p.url.includes('/error')){reply('http-response-error',{requestId:p.requestId,code:'ERR_GATEWAY_TIMEOUT',message:'timeout'});return;}
      const data=p.url.includes('/bad-json')?'not json':p.url.includes('/json')?'null':p.body?.length?new TextDecoder().decode(p.body):'hello';
      reply('http-response-start',{requestId:p.requestId,status:p.url.includes('/empty')?204:200,statusText:'OK',headers:{'content-type':'text/plain','content-length':String(data.length)},finalUrl:'/result',redirected:true});
      if(!p.url.includes('/empty')&&p.method!=='HEAD')reply('http-response-chunk',{requestId:p.requestId,bytes:encode(data)});
      reply('http-response-end',{requestId:p.requestId});
    }
    if(message.type==='ws-open')reply('ws-opened',{socketId:p.socketId,protocol:p.protocols[0]||''});
    if(message.type==='ws-send')reply('ws-message',{socketId:p.socketId,bytes:p.bytes,binary:p.binary});
    if(message.type==='ws-close')reply('ws-closed',{socketId:p.socketId,code:p.code,reason:p.reason,wasClean:true});
    if(message.type==='history')reply('history',{path:p.path,state:p.state,length:2,popstate:p.kind==='go'});
  };
  const context=vm.createContext({Event,EventTarget,CustomEvent:DetailEvent,ProgressEvent:DetailEvent,PopStateEvent:DetailEvent,MessageEvent:DetailEvent,CloseEvent:DetailEvent,
    Request,Response,Headers,URL,URLSearchParams,Blob,ReadableStream,AbortController,DOMException,ArrayBuffer,Uint8Array,TextEncoder,TextDecoder,structuredClone,setTimeout,clearTimeout,
    parent,document:doc,history:nativeHistory,navigator:{sendBeacon(){}},HTMLFormElement:Form,
    FormData:class {constructor(form){this.data=form.data||[]}*[Symbol.iterator](){yield* this.data}},
    addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events),dispatchEvent:events.dispatchEvent.bind(events)});
  vm.runInContext(source,context,{filename});vm.runInContext('directIframeBootstrap()',context);
  events.addEventListener('nacelle-gateway-error',event=>diagnostics.push(event.detail));
  const init={protocol:GATEWAY_PROTOCOL,version:1,sessionId:'session',nonce:'a'.repeat(48),sequence:1,type:'init',payload:{path:'/',virtualPort:3000,maxBodyBytes,historyState:null,historyLength:1,resources,documentHtml,requestId:documentHtml===undefined?undefined:'nav-1',diagnostics:[{code:'ERR_GATEWAY_RESOURCE_UNSUPPORTED',message:'fixture'}]}};
  const initializeFrame=(change={},source=parent)=>{const event=new Event('message');Object.assign(event,{source,ports:[port],data:{...init,...change}});events.dispatchEvent(event)};
  // Account for init's sequence, which travels over Window rather than the port.
  peer.send('init',init.payload);
  if(initialize)initializeFrame();
  t.after(()=>reply('close',{}));
  return {context,received,diagnostics,body,doc,events,port,init,reply,initializeFrame,Form,run:code=>vm.runInContext(code,context),dispatch(type,properties={}){const event=new Event(type,{cancelable:true});for(const [key,value]of Object.entries(properties))Object.defineProperty(event,key,{value});events.dispatchEvent(event);return event}};
}

test('bootstrap validates init and parent envelopes, ignores duplicates and closes on gaps',async t=>{
  const h=fixture(t,{initialize:false});h.initializeFrame({},{});h.initializeFrame({version:2});h.initializeFrame({nonce:'bad'});assert.equal(h.received.length,0);
  h.initializeFrame();await tick();assert.equal(h.received[0].type,'ready');
  h.port.onmessage({data:{...h.init,nonce:'wrong'}});assert.equal(h.diagnostics.at(-1).code,'ERR_GATEWAY_PROTOCOL');
  const count=h.diagnostics.length;h.port.onmessage({data:{...h.init,type:'history'}});assert.equal(h.diagnostics.length,count);
  h.port.onmessage({data:{...h.init,sequence:100}});assert.equal(h.diagnostics.at(-1).code,'ERR_GATEWAY_SEQUENCE');assert.equal(h.port.closed,true);
  await assert.rejects(h.context.fetch('/'),{code:'ERR_GATEWAY_CLOSED'});
});

test('bootstrap fetch streams responses, clones request options, rejects size/abort, and cancels readers',async t=>{
  const h=fixture(t);const response=await h.context.fetch('/api',{method:'POST',body:'posted'});assert.equal(await response.text(),'posted');assert.equal(response.url,'http://localhost:3000/result');assert.equal(response.redirected,true);
  const request=new Request('http://localhost:3000/request',{method:'POST',body:'request'});assert.equal(await (await h.context.fetch(request)).text(),'request');
  assert.equal(await (await h.context.fetch('/empty')).text(),'');assert.equal(await (await h.context.fetch('/head',{method:'HEAD'})).text(),'');
  await assert.rejects(h.context.fetch('/api',{method:'POST',body:'x'.repeat(129)}),{code:'ERR_GATEWAY_BODY_LIMIT'});
  const controller=new AbortController();controller.abort();await assert.rejects(h.context.fetch('/',{signal:controller.signal}),{name:'AbortError'});
  const active=new AbortController();const pending=h.context.fetch('/hang',{signal:active.signal});await tick();active.abort();await assert.rejects(pending,{name:'AbortError'});
  await assert.rejects(h.context.fetch('/error'),{code:'ERR_GATEWAY_TIMEOUT'});
  const stream=fixture(t,{handle(message,reply){if(message.type!=='http-request')return false;reply('http-response-start',{requestId:message.payload.requestId,status:200,headers:{},finalUrl:'/stream'});reply('http-response-chunk',{requestId:message.payload.requestId,bytes:new Uint8Array([1])});return true;}});
  const reader=(await stream.context.fetch('/')).body.getReader();await reader.read();await reader.cancel();assert.ok(stream.received.some(m=>m.type==='cancel'));
  const bad=fixture(t,{handle(message,reply){if(message.type!=='http-request')return false;reply('http-response-start',{requestId:message.payload.requestId,status:700});return true;}});
  await assert.rejects(bad.context.fetch('/'));assert.ok(bad.received.some(m=>m.type==='cancel'));
});

test('bootstrap XHR event order, response types, unsupported APIs, timeout, abort and state checks',async t=>{
  const h=fixture(t);
  for(const type of ['', 'text','arraybuffer','blob','json']){
    const xhr=new h.context.XMLHttpRequest();const states=[];xhr.onreadystatechange=()=>states.push(xhr.readyState);
    assert.equal(xhr.getResponseHeader('x'),null);assert.equal(xhr.getAllResponseHeaders(),'');assert.equal(xhr.withCredentials,false);xhr.withCredentials=false;
    assert.throws(()=>xhr.send(),{name:'InvalidStateError'});assert.throws(()=>xhr.setRequestHeader('a','b'),{name:'InvalidStateError'});
    xhr.open('POST',type==='json'?'/json':'/xhr');xhr.responseType=type;xhr.setRequestHeader('x-test','yes');
    const done=new Promise(resolve=>xhr.onloadend=resolve);xhr.send('body');assert.throws(()=>xhr.send());await done;
    assert.equal(xhr.status,200);assert.equal(xhr.readyState,4);assert.ok(states.includes(2)&&states.includes(3));assert.equal(xhr.getResponseHeader('content-type'),'text/plain');assert.match(xhr.getAllResponseHeaders(),/content-type/);assert.ok(xhr.responseURL);
    if(type==='arraybuffer')assert.equal(xhr.response.byteLength,4);else if(type==='blob')assert.equal(await xhr.response.text(),'body');else if(type==='json')assert.equal(xhr.response,null);else assert.equal(xhr.responseText,'body');
    if(type==='blob')assert.throws(()=>xhr.responseText,{name:'InvalidStateError'});
  }
  const invalid=new h.context.XMLHttpRequest();
  for(const action of [()=>invalid.open('GET','/',false),()=>invalid.open('GET','/',true,'user'),()=>invalid.withCredentials=true,()=>invalid.overrideMimeType(),()=>invalid.responseXML])assert.throws(action,{code:'ERR_GATEWAY_RESOURCE_UNSUPPORTED'});
  invalid.open('GET','/');invalid.responseType='document';assert.throws(()=>invalid.send(),{code:'ERR_GATEWAY_RESOURCE_UNSUPPORTED'});
  for(const mode of ['timeout','abort','error','reopen','bad-json']){
    const xhr=new h.context.XMLHttpRequest();xhr.open('GET',mode==='error'?'/error':mode==='bad-json'?'/bad-json':'/hang');xhr.timeout=mode==='timeout'?5:0;if(mode==='bad-json')xhr.responseType='json';
    let result;for(const event of ['timeout','abort','error','load'])xhr[`on${event}`]=()=>result=event;
    const done=new Promise(resolve=>xhr.onloadend=resolve);xhr.send();
    if(mode==='abort')xhr.abort();if(mode==='reopen')xhr.open('GET','/next');await done;
    assert.equal(result,mode==='reopen'?'abort':mode==='bad-json'?'load':mode);if(mode==='bad-json')assert.equal(xhr.response,null);
  }
});

test('bootstrap WebSockets implement state, ordering, binary types, events, close and unsupported inputs',async t=>{
  const h=fixture(t);const WS=h.context.WebSocket;
  assert.equal(WS.OPEN,1);assert.throws(()=>new WS('/',['x','x']),{name:'SyntaxError'});assert.throws(()=>new WS('/',['bad token']),{name:'SyntaxError'});
  const ws=new WS('/','echo');assert.equal(ws.readyState,WS.CONNECTING);assert.throws(()=>ws.send('early'),{name:'InvalidStateError'});
  await new Promise(resolve=>ws.onopen=resolve);assert.equal(ws.protocol,'echo');assert.equal(ws.extensions,'');assert.equal(ws.url,'ws://localhost:3000/');
  ws.binaryType='invalid';assert.equal(ws.binaryType,'blob');
  const seen=[];ws.onmessage=event=>seen.push(event.data);ws.send('text');ws.send(new Uint8Array([1]));ws.send(new Blob(['blob']));ws.send(new Uint8Array([3]).buffer);assert.ok(ws.bufferedAmount>0);await tick();
  assert.equal(seen[0],'text');assert.ok(seen[1]instanceof Blob);assert.equal(ws.bufferedAmount,0);
  ws.binaryType='arraybuffer';ws.send(new Uint8Array([2]));await tick();assert.deepEqual([...new Uint8Array(seen.at(-1))],[2]);
  assert.throws(()=>ws.send('x'.repeat(129)),{code:'ERR_GATEWAY_BODY_LIMIT'});assert.throws(()=>ws.close(2000),{name:'InvalidAccessError'});assert.throws(()=>ws.close(1000,'x'.repeat(124)),{name:'SyntaxError'});
  const closed=new Promise(resolve=>ws.onclose=resolve);ws.close(3000,'done');ws.close();const event=await closed;assert.equal(event.code,3000);assert.equal(ws.readyState,WS.CLOSED);ws.send('ignored');
  const early=new WS('/');early.close();await tick();assert.equal(early.readyState,WS.CLOSED);
  const failing=new WS('/');await new Promise(resolve=>failing.onopen=resolve);h.reply('ws-error',{socketId:h.received.filter(m=>m.type==='ws-open').at(-1).payload.socketId});await tick();assert.equal(failing.readyState,WS.CLOSED);
  h.reply('ws-message',{socketId:'missing'});
});

test('bootstrap links, forms, virtual history and unsupported resource diagnostics',async t=>{
  const h=fixture(t);const link=new Element('A',{href:'/next'});
  assert.equal(h.dispatch('click',{target:{closest:()=>link}}).defaultPrevented,true);h.dispatch('click',{target:{}});await tick();assert.ok(h.received.some(m=>m.type==='navigation'&&m.payload.url==='/next'));
  for(const [method,encoding]of [['GET',''],['POST','application/x-www-form-urlencoded'],['POST','multipart/form-data'],['POST','text/plain'],['DELETE','']]){
    const form=new h.Form('FORM',{method,action:'/form',enctype:encoding});form.data=[['name','A B'],['file',{name:'file.txt'}]];
    h.dispatch('submit',{target:form});await tick();
  }
  const form=new h.Form('FORM',{});form.submit();await tick();assert.ok(h.received.some(m=>m.type==='navigation'&&m.payload.method==='POST'));
  h.context.history.pushState({x:1},'', '/route');assert.equal(h.context.history.state.x,1);assert.ok(h.context.history.length>=2);
  h.context.history.replaceState(null,'',null);assert.throws(()=>h.context.history.pushState({},'','https://external.invalid'),{name:'SecurityError'});
  h.context.history.back();h.context.history.forward();h.context.history.go();await tick();
  for(const name of ['EventSource','Worker','SharedWorker','WebTransport'])assert.throws(()=>new h.context[name]('/'),{code:'ERR_GATEWAY_RESOURCE_UNSUPPORTED'});
  assert.throws(()=>h.context.navigator.sendBeacon('/'),{code:'ERR_GATEWAY_RESOURCE_UNSUPPORTED'});
  h.dispatch('securitypolicyviolation',{violatedDirective:'img-src',blockedURI:'https://external.invalid'});await tick();
  h.reply('diagnostic',{code:'ERR_GATEWAY_NAVIGATION',message:'fixture'});h.reply('navigation-error',{code:'ERR_GATEWAY_NAVIGATION',message:'bad'});await tick();
  assert.ok(h.diagnostics.length>=8);h.dispatch('pagehide');assert.equal(h.port.closed,true);
});

test('bootstrap renders authenticated blob catalogs, stages scripts, and revokes document-local resources on close',async t=>{
  const scripts=[new Element('SCRIPT',{src:'parent:script'}),new Element('SCRIPT',{type:'module'}),new Element('SCRIPT',{type:'application/json'}),new Element('SCRIPT',{src:'parent:script',defer:''})];
  scripts[1].textContent='export {}';
  const h=fixture(t,{resources:[{url:'parent:asset',blob:new Blob(['x'],{type:'image/png'})},{url:'parent:css',blob:new Blob(['url(parent:asset)'],{type:'text/css'})},{url:'parent:script',blob:new Blob(['// script'],{type:'text/javascript'})}],documentHtml:'fixture',renderScripts:scripts});
  await tick();assert.ok(h.received.some(m=>m.type==='loaded'));h.reply('close',{});await tick();assert.equal(h.port.closed,true);
});
