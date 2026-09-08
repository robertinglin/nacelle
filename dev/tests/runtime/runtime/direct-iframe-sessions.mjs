import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { webcrypto } from 'node:crypto';
import { createDirectIframeGateway } from '../../../../src/runtime/direct-iframe-gateway.js';
import { normalizeGatewayOptions } from '../../../../src/runtime/gateway-selection.js';
import { createEnvelopePeer, GATEWAY_PROTOCOL } from '../../../../src/runtime/direct-iframe-protocol.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const until = async predicate => { for (let i=0;i<100;i++) { if(predicate())return; await tick(); } assert.fail('gateway did not settle'); };
function channel() {
  const port = () => ({ onmessage:null, closed:false, start(){}, close(){this.closed=true;}, postMessage(message, transfer=[]) {
    const data = structuredClone(message, { transfer });
    queueMicrotask(() => { if (!this.other.closed) this.other.onmessage?.({data}); });
  } });
  this.port1=port();this.port2=port();this.port1.other=this.port2;this.port2.other=this.port1;
}
function setup(t, {autoReady=true, options={}, limits={}, respond, throwTransfer=false, callbackThrows=false}={}) {
  const events=new EventTarget(); const diagnostics=[]; const sockets=[]; const messages=[]; const channels=[];const calls=[];
  let client;let activePort;let terminal=0;let observer;
  const attributes=new Map();
  const iframe = new EventTarget();iframe.isConnected=true;
  iframe.setAttribute=(key,value)=>attributes.set(key,value);iframe.getAttribute=key=>attributes.get(key);
  iframe.contentWindow={postMessage(init,_origin,[port]) {
    if (throwTransfer) throw new Error('transfer failed');
    activePort=port;channels.push(port);messages.push(init);
    client=createEnvelopePeer({sessionId:init.sessionId,nonce:init.nonce,send:(data,transfers)=>port.postMessage(data,transfers),onError:error=>{throw error}});
    port.onmessage=event=>messages.push(event.data);
    if(autoReady) { client.send('ready',{bootstrapVersion:1});if(init.payload.requestId)client.send('loaded',{requestId:init.payload.requestId,path:init.payload.path,title:'fixture'}); }
  }};
  Object.defineProperty(iframe,'srcdoc',{set(value){this.document=value;queueMicrotask(()=>this.dispatchEvent(new Event('load')))},get(){return this.document}});
  const scope={crypto:webcrypto,AbortController,MessageChannel:channel,URL,Blob,setTimeout,clearTimeout,location:{href:'https://host.test/'},
    document:{documentElement:{},createElement:()=>({innerHTML:'',content:{querySelectorAll:()=>[]}})},
    addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events),
    MutationObserver:class {constructor(callback){observer=callback} observe(){} disconnect(){observer=null}}};
  const net={connect(address){
    const socket=new EventEmitter();socket.destroyed=false;socket.destroy=()=>{socket.destroyed=true};socket.write=bytes=>{
      const text=new TextDecoder().decode(bytes); if(!text.includes('HTTP/1.1'))return;
      calls.push(text);queueMicrotask(()=>{
        if(socket.destroyed)return;
        const response=respond?.(text,socket) ?? 'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 5\r\n\r\nhello';
        if(response!==false)socket.emit('data',new TextEncoder().encode(response));
      });
    };sockets.push(socket);return socket;
  }};
  const close=createDirectIframeGateway({iframe,net,globalObject:scope,gatewayOptions:normalizeGatewayOptions({mode:'direct-iframe',requestTimeoutMs:500,...limits}),
    options:{autoLoad:false,...options,onClose(){terminal++;if(callbackThrows)throw new Error('observer')},onError(){if(callbackThrows)throw new Error('observer')},onNavigate(){if(callbackThrows)throw new Error('observer')}},
    onDiagnostic:detail=>diagnostics.push(detail),onClose(){if(callbackThrows)throw new Error('observer')}});
  t.after(close);
  return {close,iframe,scope,diagnostics,sockets,messages,channels,calls,
    send:(type,payload={})=>client.send(type,payload),raw:message=>activePort.postMessage(message),
    windowMessage(source,data={protocol:GATEWAY_PROTOCOL}){const event=new Event('message');Object.assign(event,{source,data});events.dispatchEvent(event)},
    observe:()=>observer?.(),get terminal(){return terminal}};
}

test('session handshake, clean navigation/history and idempotent teardown',async t=>{
  const h=setup(t,{callbackThrows:true});await until(()=>h.close.getDiagnostic().state==='ready');
  assert.equal(h.iframe.getAttribute('sandbox'),'allow-scripts allow-forms');
  assert.equal(h.iframe.getAttribute('referrerpolicy'),'no-referrer');
  await h.close.navigate('/one?q=1#frag');assert.equal(h.close.getDiagnostic().path,'/one?q=1#frag');assert.match(h.calls[0],/^GET \/one\?q=1 HTTP/);
  h.send('history',{kind:'pushState',path:'/two',state:{x:1}});await until(()=>h.close.getDiagnostic().path==='/two');
  h.send('history',{kind:'replaceState',path:'/three',state:null});await until(()=>h.close.getDiagnostic().path==='/three');
  h.close.back();await until(()=>h.close.getDiagnostic().path==='/one?q=1#frag'&&h.close.getDiagnostic().state==='loaded');
  h.close.forward();await until(()=>h.close.getDiagnostic().path==='/three'&&h.close.getDiagnostic().state==='loaded');
  h.send('history',{kind:'go',delta:999});h.send('history',{kind:'go',delta:0.5});h.send('history',{kind:'unknown'});await tick();
  assert.equal(h.diagnostics.filter(d=>d.code==='ERR_GATEWAY_PROTOCOL').length,2);
  h.close();h.close();assert.equal(h.terminal,1);assert.equal(h.close.getDiagnostic().state,'closed');
  assert.ok(h.channels.every(port=>port.closed));assert.ok(h.sockets.every(socket=>socket.destroyed));
  await assert.rejects(h.close.navigate('/'),{code:'ERR_GATEWAY_CLOSED'});
});

test('session authenticates window source, port, nonce, version, payload and sequences before dispatch',async t=>{
  const h=setup(t);await until(()=>h.messages.length);
  h.windowMessage({});h.windowMessage(h.iframe.contentWindow);h.windowMessage({},{});
  const init=h.messages[0];
  for(const change of [{nonce:'wrong'},{version:2},{sessionId:'wrong'},{payload:[]},{type:1}])h.raw({...init,sequence:2,type:'http-request',payload:{requestId:'bad',url:'/'},...change});
  await tick();assert.equal(h.calls.length,0);assert.equal(h.diagnostics.length,7);
  h.send('wat',{});h.send('loaded',{requestId:'fake',path:'/'});h.send('ready',{bootstrapVersion:1});await tick();
  assert.equal(h.calls.length,0);
  h.raw({...init,type:'http-request',sequence:20,payload:{requestId:'gap',url:'/'}});await tick();
  assert.equal(h.close.getDiagnostic().state,'closed');assert.equal(h.diagnostics.at(-1).code,'ERR_GATEWAY_SEQUENCE');
});

test('HTTP messages stream in order, reject duplicate IDs, cancel sockets and time out deterministically',async t=>{
  const h=setup(t,{limits:{requestTimeoutMs:80,maxConcurrentRequests:1},respond:(head)=>head.includes('/hang')?false:undefined});
  await until(()=>h.close.getDiagnostic().state==='ready');
  h.send('http-request',{requestId:'normal',url:'/api',headers:[['x-test','yes']]});
  await until(()=>h.messages.some(m=>m.type==='http-response-end'));
  assert.deepEqual(h.messages.filter(m=>m.payload.requestId==='normal').map(m=>m.type),['http-response-start','http-response-chunk','http-response-end']);
  h.send('http-request',{requestId:'hang',url:'/hang'});await until(()=>h.close.getDiagnostic().pendingRequests===1);
  h.send('http-request',{requestId:'hang',url:'/hang'});h.send('http-request',{requestId:'extra',url:'/hang'});await tick();
  assert.ok(h.diagnostics.some(d=>d.code==='ERR_GATEWAY_PROTOCOL'));assert.ok(h.diagnostics.some(d=>d.code==='ERR_GATEWAY_REQUEST_LIMIT'));
  h.send('cancel',{requestId:'hang'});await until(()=>h.close.getDiagnostic().pendingRequests===0);
  h.send('cancel',{requestId:'missing'});
  h.send('http-request',{requestId:'timeout',url:'/hang'});await until(()=>h.diagnostics.some(d=>d.code==='ERR_GATEWAY_TIMEOUT'));
  assert.equal(h.close.getDiagnostic().pendingRequests,0);assert.ok(h.sockets.every(socket=>socket.destroyed));
});

test('HTTP validation and oversized responses never escape to host networking',async t=>{
  const h=setup(t,{limits:{maxBodyBytes:3}});await until(()=>h.close.getDiagnostic().state==='ready');
  for(const payload of [{url:'https://host.test/'},{url:'/',credentials:'include'},{url:'/',method:'POST',body:'1234'},{url:'/',requestId:'bad id'}]) h.send('http-request',{requestId:'test',...payload});
  await tick();assert.equal(h.calls.length,0);
  h.send('http-request',{requestId:'size',url:'/'});await until(()=>h.messages.some(m=>m.payload.requestId==='size'&&m.type==='http-response-error'));
  assert.equal(h.diagnostics.at(-1).code,'ERR_GATEWAY_BODY_LIMIT');
});

test('redirect method changes, manual redirects, errors, loop cap, and failed navigation preserves committed path',async t=>{
  const h=setup(t,{respond:head=>{
    if(head.includes(' /redirect '))return 'HTTP/1.1 303 See Other\r\nLocation: /ok?next=1\r\nContent-Length: 0\r\n\r\n';
    if(head.includes(' /loop '))return 'HTTP/1.1 307 Temporary Redirect\r\nLocation: /loop\r\nContent-Length: 0\r\n\r\n';
    if(head.includes(' /external '))return 'HTTP/1.1 302 Found\r\nLocation: https://host.test/\r\nContent-Length: 0\r\n\r\n';
    if(head.includes(' /bad '))return 'BAD RESPONSE\r\n\r\n';
  }});await until(()=>h.close.getDiagnostic().state==='ready');
  h.send('navigation',{url:'/redirect',method:'POST',body:'post',headers:{'content-type':'text/plain'}});
  await until(()=>h.close.getDiagnostic().state==='loaded');assert.equal(h.close.getDiagnostic().path,'/ok?next=1');
  assert.match(h.calls[1],/^GET \/ok\?next=1/);assert.doesNotMatch(h.calls[1],/content-type/);
  await assert.rejects(h.close.navigate('/bad'));assert.equal(h.close.getDiagnostic().path,'/ok?next=1');
  await assert.rejects(h.close.navigate('https://host.test/'),{code:'ERR_GATEWAY_NAVIGATION'});
  for(const [id,url,redirect] of [['manual','/redirect','manual'],['error','/redirect','error'],['external','/external','follow'],['loop','/loop','follow']])h.send('http-request',{requestId:id,url,redirect});
  await until(()=>h.messages.some(m=>m.payload.requestId==='loop'&&m.type==='http-response-error'));
  const start=h.messages.find(m=>m.type==='http-response-start'&&m.payload.requestId==='manual');assert.equal(start.payload.headers.location,'/ok?next=1');
  assert.ok(h.messages.some(m=>m.payload.requestId==='error'&&m.type==='http-response-error'));
});

test('navigation replacement cancels old work and does not deliver errors into the new document channel',async t=>{
  const h=setup(t,{respond:head=>head.includes('/hang')?false:undefined});await until(()=>h.close.getDiagnostic().state==='ready');
  const replaced=h.close.navigate('/hang');const rejected=assert.rejects(replaced,{code:'ERR_GATEWAY_CLOSED'});
  await until(()=>h.close.getDiagnostic().pendingRequests===1);
  await h.close.navigate('/new');await rejected;assert.equal(h.close.getDiagnostic().path,'/new');
  assert.equal(h.close.getDiagnostic().pendingRequests,0);
});

test('pre-ready requests, handshake timeouts, transfer failures, removal and sandbox tampering close safely',async t=>{
  const h=setup(t,{autoReady:false,limits:{requestTimeoutMs:30}});await until(()=>h.messages.length);
  h.send('http-request',{requestId:'early',url:'/'});h.send('ws-open',{socketId:'early',url:'/'});await tick();
  assert.equal(h.calls.length,0);await until(()=>h.close.getDiagnostic().state==='closed');
  assert.ok(h.diagnostics.some(d=>d.code==='ERR_GATEWAY_TIMEOUT'));
  const failed=setup(t,{throwTransfer:true});await until(()=>failed.close.getDiagnostic().state==='closed');assert.equal(failed.diagnostics[0].code,'ERR_GATEWAY_SESSION');
  const removed=setup(t);removed.iframe.isConnected=false;removed.observe();assert.equal(removed.terminal,1);
  const tampered=setup(t);tampered.iframe.setAttribute('sandbox','allow-scripts allow-same-origin');tampered.observe();assert.equal(tampered.terminal,1);
});

test('initial navigation queues, unsupported content errors, client close and navigation timeout',async t=>{
  const h=setup(t,{options:{autoLoad:true},respond:()=> 'HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 0\r\n\r\n'});
  await until(()=>h.diagnostics.length);assert.equal(h.diagnostics[0].code,'ERR_GATEWAY_RESOURCE_UNSUPPORTED');
  h.send('ws-send',{socketId:'missing',bytes:new Uint8Array(),binary:true});h.send('ws-close',{socketId:'missing'});
  h.send('error',{code:'bad',message:'untrusted'});await tick();assert.equal(h.diagnostics.at(-1).code,'ERR_GATEWAY_NAVIGATION');
  h.send('close',{});await until(()=>h.terminal===1);
  const stalled=setup(t,{respond:()=>false,limits:{requestTimeoutMs:20}});await until(()=>stalled.close.getDiagnostic().state==='ready');
  await assert.rejects(stalled.close.navigate('/hang'),{code:'ERR_GATEWAY_TIMEOUT'});assert.equal(stalled.terminal,1);
});

test('session construction rejects missing DOM and secure primitives',()=>{
  assert.throws(()=>createDirectIframeGateway({iframe:null}),{code:'ERR_GATEWAY_SESSION'});
});
