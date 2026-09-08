import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rewriteDocument,createBlobOwner} from '../../../../src/runtime/direct-iframe-resources.js';
class Element {
  constructor(tag,attributes={},text=''){this.tagName=tag.toUpperCase();this.attrs=new Map(Object.entries(attributes));this.textContent=text;this.removed=false;}
  get attributes(){return [...this.attrs].map(([name,value])=>({name,value}))}get type(){return this.getAttribute('type')||''}get rel(){return this.getAttribute('rel')||''}
  getAttribute(name){return this.attrs.get(name)??null}hasAttribute(name){return this.attrs.has(name)}setAttribute(name,value){this.attrs.set(name,value)}removeAttribute(name){this.attrs.delete(name)}remove(){this.removed=true}
}
async function fixture(elements,responses={},limit=10000){
  let count=0;const blobs=new Map();const diagnostics=[];const calls=[];
  const scope={Blob,URL:{createObjectURL(blob){const url=`blob:fixture-${++count}`;blobs.set(url,blob);return url},revokeObjectURL(){}},document:{createElement(){return {innerHTML:'',content:{querySelectorAll(selector){return elements.filter(element=>!element.removed&&(selector==='*'||['BASE','IFRAME','FRAME','FRAMESET','OBJECT','EMBED','LINK'].includes(element.tagName)||(element.tagName==='META'&&element.hasAttribute('http-equiv'))))}}}}}};
  const owner=createBlobOwner(scope);
  const result=await rewriteDocument({html:'fixture',path:'/dir/page?q=1',port:3000,pageUrl:'https://host.test/',scope,owner,maxBodyBytes:limit,onDiagnostic:error=>diagnostics.push(error),request:async path=>{
    calls.push(path);const input=responses[path]??responses[path.split('#')[0]]??{text:'asset'};
    if(input instanceof Error)throw input;
    return {status:200,headers:{},contentType:'application/octet-stream',finalUrl:path,bytes:new TextEncoder().encode(input.text||''),...input};
  }});
  return {elements,blobs,diagnostics,calls,result,owner};
}

test('resource loader rewrites all supported tags, module/CSS dependencies, query strings, fragments and navigation attributes',async()=>{
  const elements=[new Element('script',{src:'./classic.js?q=1'}),new Element('script',{src:'/module.js',type:'module'}),new Element('script',{type:'module'},'import "./dependency.js"; console.log(import.meta.url)'),
    new Element('link',{rel:'stylesheet',href:'/style.css'}),new Element('link',{rel:'modulepreload',href:'/module.js'}),new Element('link',{rel:'import',href:'/module.js'}),
    ...['img','source','video','audio','track','input'].map(tag=>new Element(tag,{src:'/image.png?q=1#one'})),new Element('img',{src:'/image.png?q=1#two'}),new Element('video',{poster:'/poster.png'}),
    new Element('div',{style:'background:url(/background.png)'}),new Element('style',{},'@import "/style.css";x{background:url(/background.png)}'),
    new Element('a',{href:'./next?q=2',target:'_top',download:''}),new Element('form',{action:'/submit',target:'_top'}),new Element('button',{formaction:'/other'})];
  const h=await fixture(elements,{'/module.js':{text:'export { value } from "./dependency.js"; import("./dynamic.js");'},'/style.css':{text:'@import "/nested.css";x{background:url(/image.png?q=1#css)}'},'/nested.css':{text:'x{}'},'/dependency.js':{text:'export const value=1'},'/dir/dependency.js':{text:'export const value=1'}});
  assert.deepEqual(h.diagnostics,[]);assert.ok(elements[0].getAttribute('src').startsWith('blob:'));
  const first=elements[6].getAttribute('src');const second=elements[12].getAttribute('src');assert.equal(first.split('#')[0],second.split('#')[0]);assert.match(first,/#one$/);assert.match(second,/#two$/);
  assert.equal(h.calls.filter(path=>path.startsWith('/image.png')).length,1);
  assert.equal(elements.at(-3).getAttribute('data-nacelle-href'),'/dir/next?q=2');assert.equal(elements.at(-3).getAttribute('target'),null);
  assert.equal(elements.at(-2).getAttribute('data-nacelle-action'),'/submit');assert.equal(elements.at(-1).getAttribute('data-nacelle-formaction'),'/other');
  assert.match(await h.blobs.get(elements[1].getAttribute('src')).text(),/blob:fixture/);assert.match(elements[2].textContent,/http:\/\/localhost:3000\/dir\/page\?q=1/);
  assert.equal(h.owner.resources.length,h.blobs.size);h.owner.close();assert.equal(h.owner.size,0);
});

test('unsupported active elements, attributes, encodings, script imports and CSS fail visibly without requesting external URLs',async()=>{
  const elements=[...['base','iframe','frame','frameset','object','embed'].map(tag=>new Element(tag,{src:'/secret'})),new Element('meta',{'http-equiv':'refresh'}),new Element('link',{rel:'prefetch',href:'/secret'}),
    new Element('img',{srcset:'/secret 2x',src:'https://host.test/secret',ping:'/secret',background:'/secret',srcdoc:'bad',manifest:'/secret','xlink:href':'/secret'}),
    new Element('div',{style:'background:image-set(url(/secret) 2x)',href:'/secret',src:'/secret'}),new Element('style',{},'x{background:url(\\61)}'),
    new Element('script',{type:'importmap'},'{}'),new Element('script',{},'import(name)'),new Element('script',{type:'module'},'import "bare"'),new Element('script',{src:'/bare.js',type:'module'}),
    new Element('script',{src:'/integrity.js',integrity:'sha256-test'}),new Element('a',{href:'javascript:alert(1)'}),new Element('form',{action:'https://host.test/'}),new Element('button',{formaction:'https://host.test/'}),
    new Element('video',{poster:'https://host.test/'}),new Element('img',{src:'/404'}),new Element('img',{src:'/encoded'}),new Element('img',{src:'/throw'})];
  const h=await fixture(elements,{'/bare.js':{text:'import "bare"'},'/404':{status:404},'/encoded':{headers:{'content-encoding':'gzip'}},'/throw':new Error('fixture network')});
  assert.ok(h.diagnostics.length>=20);assert.ok(h.diagnostics.every(error=>error.code.startsWith('ERR_GATEWAY_')));
  assert.ok(h.calls.every(path=>!path.includes('host.test')&&path!=='/secret'&&path!=='/integrity.js'));
  assert.equal(elements[8].hasAttribute('srcset'),false);assert.equal(elements[9].hasAttribute('style'),false);assert.equal(elements[10].textContent,'');assert.equal(elements[11].removed,true);
});

test('resource cache rejects cycles and enforces aggregate body and resource count limits',async()=>{
  const cycle=await fixture([new Element('link',{rel:'stylesheet',href:'/cycle.css'})],{'/cycle.css':{text:'@import "/cycle.css";'}});assert.match(cycle.diagnostics[0].message,/Cyclic/);
  const size=await fixture([new Element('img',{src:'/big'})],{'/big':{text:'oversize'}},3);assert.equal(size.diagnostics[0].code,'ERR_GATEWAY_BODY_LIMIT');
  const count=await fixture(Array.from({length:1025},(_,i)=>new Element('img',{src:`/asset-${i}`})),{},10000);assert.equal(count.diagnostics.at(-1).code,'ERR_GATEWAY_REQUEST_LIMIT');assert.equal(count.calls.length,1024);
});
