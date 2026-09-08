import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {webcrypto,createHash} from 'node:crypto';
import {openDirectWebSocket,validateWebSocketProtocols} from '../../../../src/runtime/direct-iframe-websocket.js';
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
const frame=(opcode,bytes=[],final=true)=>{
  bytes=new Uint8Array(bytes);const extra=bytes.length<126?0:bytes.length<=65535?2:8;const result=new Uint8Array(2+extra+bytes.length);
  result[0]=(final?128:0)|opcode;result[1]=extra===0?bytes.length:extra===2?126:127;
  if(extra===2)new DataView(result.buffer).setUint16(2,bytes.length);
  if(extra===8)new DataView(result.buffer).setBigUint64(2,BigInt(bytes.length));
  result.set(bytes,2+extra);return result;
};
function fixture(t,{protocols=['echo'],headers,limit=100000,upgrade=true}={}){
  const socket=new EventEmitter();const writes=[];const errors=[];const messages=[];const closes=[];let opened;let resolveReady;const ready=new Promise(resolve=>resolveReady=resolve);
  const controller=new AbortController();socket.destroy=()=>{socket.destroyed=true};
  socket.write=bytes=>{
    writes.push(bytes.slice());const head=new TextDecoder().decode(bytes);
    if(head.startsWith('GET ')&&upgrade){const key=/Sec-WebSocket-Key: ([^\r]+)/.exec(head)[1];
      const accept=createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      const data=headers?.(accept)??`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${protocols.length?'Sec-WebSocket-Protocol: echo\r\n':''}\r\n`;
      queueMicrotask(()=>socket.emit('data',new TextEncoder().encode(data)));
    }
  };
  const client=openDirectWebSocket({net:{connect:()=>socket},port:3000,path:'/socket?q=1',protocols,scope:{crypto:webcrypto,setTimeout,clearTimeout},maxBodyBytes:limit,signal:controller.signal,
    onOpen:value=>{opened=value;resolveReady()},onMessage:(bytes,binary)=>messages.push({bytes:[...bytes],binary}),onClose:value=>{closes.push(value);resolveReady()},onError:error=>errors.push(error)});
  t.after(()=>controller.abort());return {ready,client,socket,writes,errors,messages,closes,controller,get opened(){return opened}};
}

test('WebSocket protocols are bounded, unique tokens',()=>{
  assert.deepEqual(validateWebSocketProtocols(),[]);assert.deepEqual(validateWebSocketProtocols('echo'),['echo']);
  for(const value of [null,{},['a','a'],['bad token'],[1],['x'.repeat(257)],Array(33).fill('a')])assert.throws(()=>validateWebSocketProtocols(value),{code:'ERR_GATEWAY_PROTOCOL'});
  assert.throws(()=>openDirectWebSocket({scope:{},net:{connect(){assert.fail('must validate before socket')}}}),{code:'ERR_GATEWAY_SESSION'});
});

test('WebSocket upgrade, masking, text/binary, fragmentation, ping/pong and clean close',async t=>{
  const h=fixture(t);await h.ready;assert.equal(h.opened,'echo');assert.match(new TextDecoder().decode(h.writes[0]),/^GET \/socket\?q=1 HTTP/);
  for(const n of [3,126,65536]){const bytes=new Uint8Array(n).fill(42);h.client.send(bytes,true);const wire=h.writes.at(-1);assert.ok(wire[1]&128);const offset=n<126?2:n<=65535?4:10;const mask=wire.subarray(offset,offset+4);assert.ok(wire.subarray(offset+4).every((value,index)=>(value^mask[index%4])===42));}
  h.client.send(new TextEncoder().encode('text'),false);assert.equal(h.writes.at(-1)[0],129);
  h.socket.emit('data',frame(1,[65],false));h.socket.emit('data',frame(9,[7]));h.socket.emit('data',frame(0,[66]));h.socket.emit('data',frame(10,[7]));
  for(const n of [126,65536]){const bytes=frame(2,new Uint8Array(n));for(const part of [bytes.slice(0,1),bytes.slice(1,3),bytes.slice(3,8),bytes.slice(8)])h.socket.emit('data',part);}
  await tick();assert.deepEqual(h.messages[0],{bytes:[65,66],binary:false});assert.equal(h.messages.length,3);assert.equal(h.writes.at(-1)[0],138);
  h.client.close(3000,'bye');assert.equal(h.writes.at(-1)[0],136);
  h.socket.emit('data',frame(8,[11,184,98,121,101]));await tick();assert.deepEqual(h.closes,[{code:3000,reason:'bye',wasClean:true}]);
  h.client.close();h.socket.emit('error',new Error('late'));assert.equal(h.closes.length,1);assert.ok(h.socket.destroyed);
});

test('WebSocket invalid sends, close inputs, early close and abort have one terminal event',async t=>{
  const pending=fixture(t,{upgrade:false});assert.throws(()=>pending.client.send(new Uint8Array(),true),{code:'ERR_GATEWAY_PROTOCOL'});pending.client.close();assert.equal(pending.closes.length,1);
  const h=fixture(t,{limit:128});await h.ready;
  for(const [bytes,binary] of [[[],true],[new Uint8Array(),null]])assert.throws(()=>h.client.send(bytes,binary),{code:'ERR_GATEWAY_PROTOCOL'});
  assert.throws(()=>h.client.send(new Uint8Array(129),true),{code:'ERR_GATEWAY_BODY_LIMIT'});
  assert.throws(()=>h.client.send(new Uint8Array([255]),false));
  for(const [code,reason] of [[1001,''],[1000,1],[1000,'x'.repeat(124)]])assert.throws(()=>h.client.close(code,reason),{code:'ERR_GATEWAY_PROTOCOL'});
  h.controller.abort();assert.equal(h.closes.length,1);h.socket.emit('close');assert.equal(h.closes.length,1);
});

test('WebSocket invalid upgrades and response headers fail closed',async t=>{
  for(const headers of [()=> 'HTTP/1.1 200 OK\r\n\r\n',()=> 'HTTP/1.1 101 OK\r\nbad-header\r\n\r\n',()=> 'HTTP/1.1 101 OK\r\nSec-WebSocket-Accept: wrong\r\n\r\n',accept=>`HTTP/1.1 101 OK\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: unexpected\r\n\r\n`,()=> 'x'.repeat(32769)]){
    const h=fixture(t,{headers});await h.ready;assert.equal(h.errors.length,1);assert.equal(h.closes.length,1);assert.ok(h.socket.destroyed);
  }
});

test('WebSocket rejects invalid frames, control payloads, UTF-8 and continuation sequences',async t=>{
  const invalid=[new Uint8Array([193,0]),new Uint8Array([129,128]),frame(9,[],false),frame(9,new Uint8Array(126)),frame(8,[0]),frame(8,[3,237]),frame(1,[255]),frame(0,[1]),frame(3,[1]),frame(8,[3,232,255])];
  for(const input of invalid){const h=fixture(t);await h.ready;h.socket.emit('data',input);await tick();assert.equal(h.errors.length,1,`${[...input]}`);assert.equal(h.closes.length,1);}
  const h=fixture(t);await h.ready;h.socket.emit('data',frame(1,[65],false));h.socket.emit('data',frame(1,[66]));await tick();assert.equal(h.errors.length,1);
});

test('WebSocket response size, aggregate fragment and buffer limits are enforced',async t=>{
  for(const input of [frame(2,new Uint8Array(129)),frame(2,new Uint8Array(65536)),new Uint8Array(33000)]){
    const h=fixture(t,{limit:128});await h.ready;h.socket.emit('data',input);await tick();assert.equal(h.errors[0]?.code,'ERR_GATEWAY_BODY_LIMIT');
  }
  const h=fixture(t,{limit:128});await h.ready;h.socket.emit('data',frame(2,new Uint8Array(100),false));h.socket.emit('data',frame(0,new Uint8Array(100)));await tick();assert.equal(h.errors[0].code,'ERR_GATEWAY_BODY_LIMIT');
  const empty=fixture(t,{protocols:[]});await empty.ready;empty.socket.emit('data',frame(8));await tick();assert.equal(empty.closes[0].code,1005);
});
