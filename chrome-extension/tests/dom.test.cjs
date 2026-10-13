// DOM/media-model tests complement, but do not replace, tests in actual Chrome.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm');
const {JSDOM}=require(require.resolve('jsdom',{paths:[process.env.RB_DOM_MODULES||process.cwd(),process.cwd()]}));
const core=require('../lib/core.js');const {fixture}=require('./fixtures.cjs');
const root=path.resolve(__dirname,'..'),read=name=>fs.readFileSync(path.join(root,name),'utf8');
const sleep=n=>new Promise(r=>setTimeout(r,n));
async function until(fn){for(let i=0;i<400;i++){if(fn())return;await sleep(5);}throw new Error('Timed out waiting for tested state');}
function load(win,name){win.eval(read(name));}

for(const view of ['biblereader','studyb']){
 test(`${view}: exact chapter recognition and complete verse mapping`,()=>{
  const dom=new JSDOM(fixture(view,40,1),{url:`https://bibelonline.se/${view}.php`,runScripts:'outside-only'});const w=dom.window;
  for(const n of ['lib/books.js','lib/core.js','lib/adapter.js'])load(w,n);
  const c=w.RBAudioAdapter.readContext(w.document,w.location.href),mapping=w.RBAudioAdapter.mapVerses(w.document,c);
  assert.equal(c.bookId,40);assert.equal(c.chapter,1);assert.equal(mapping.complete,true);assert.equal(mapping.map.size,25);
  assert.ok(mapping.map.get(10).element.textContent.startsWith('Text för vers 10.'));
  assert.match(w.RBAudioAdapter.navigationURL(w.document,w.location.href,w.RBAudioCore.nextChapter(c)),/book=40&chap=2/);
  dom.window.close();
 });
 test(`${view}: content bridge highlights only the verse, follows on request, and stops on pagehide`,async()=>{
  const dom=new JSDOM(fixture(view,40,1,false,true),{url:`https://bibelonline.se/${view}.php`,runScripts:'outside-only',pretendToBeVisual:true});const w=dom.window;
  const requests=[];w.chrome={runtime:{id:'test-extension',getURL:n=>`chrome-extension://test-extension/${n}`,sendMessage:async m=>{requests.push(m);return {ok:true,autoplay:false};}}};
  w.matchMedia=()=>({matches:false});
  for(const n of ['lib/books.js','lib/core.js','lib/adapter.js','content.js'])load(w,n);
  await sleep(10);const frame=w.document.querySelector('#rb-audio-dock').shadowRoot.querySelector('iframe');
  const token=new URL(frame.src).searchParams.get('session'),out=[];frame.contentWindow.postMessage=(m)=>out.push(m);
  const emit=(type,data={})=>w.dispatchEvent(new w.MessageEvent('message',{source:frame.contentWindow,origin:'chrome-extension://test-extension',data:{channel:'RB_AUDIO',token,type,...data}}));
  emit('READY');assert.equal(out.find(m=>m.type==='LOAD').context.view,view);
  assert.equal(out.find(m=>m.type==='LOAD').autoplay,false);
  const c=w.RBAudioAdapter.readContext(w.document,w.location.href),record=w.RBAudioAdapter.mapVerses(w.document,c).map.get(10);
  let scrolls=0;record.element.scrollIntoView=()=>scrolls++;record.element.getBoundingClientRect=()=>({top:1000,bottom:1100});
  emit('VERSE',{verse:10,follow:false});assert.equal(record.element.getAttribute('data-rb-spoken'),'true');assert.equal(scrolls,0);
  assert.equal(w.document.querySelectorAll('[data-rb-spoken]').length,2);
  if(view==='studyb')assert.equal(w.document.querySelector('tr.mytr:nth-of-type(11) td:nth-child(3)').hasAttribute('data-rb-spoken'),false);
  emit('FOLLOW',{follow:true});assert.equal(scrolls,1);
  emit('VERSE',{verse:11,follow:false});assert.equal(record.element.hasAttribute('data-rb-spoken'),false);
  w.dispatchEvent(new w.PageTransitionEvent('pagehide'));assert.equal(w.document.getElementById('rb-audio-dock'),null);assert.equal(w.document.querySelectorAll('[data-rb-spoken]').length,0);
  assert.ok(out.some(m=>m.type==='STOP'));assert.equal(requests[0].type,'RB_CONSUME_CONTINUATION');dom.window.close();
 });
}
test('hidden reader numbers still map one span per verse without highlighting headings',()=>{
 const dom=new JSDOM(fixture('biblereader',40,1,true),{url:'https://bibelonline.se/biblereader.php',runScripts:'outside-only'});const w=dom.window;
 for(const n of ['lib/books.js','lib/core.js','lib/adapter.js'])load(w,n);
 const c=w.RBAudioAdapter.readContext(w.document,w.location.href),r=w.RBAudioAdapter.mapVerses(w.document,c);
 assert.equal(r.complete,true);assert.equal(r.map.get(5).element.querySelector('b'),null);dom.window.close();
});

function playerHarness({corrupt=false,missing=false,autoplayBlocked=false}={}){
 const origin='https://bibelonline.se',token='media-test';
 const dom=new JSDOM(read('player.html'),{url:`chrome-extension://test-extension/player.html?origin=${encodeURIComponent(origin)}&session=${token}`,runScripts:'outside-only',pretendToBeVisual:true});const w=dom.window;
 const messages=[],media=[],fetches=[],blobs=new Map();let blobId=0;
 const parent={postMessage:m=>messages.push(m)};Object.defineProperty(w,'parent',{value:parent});
 w.chrome={storage:{local:{get:async()=>({}),set:async()=>{}}}};w.ResizeObserver=class{observe(){}disconnect(){}};
 Object.defineProperty(w.crypto,'subtle',{value:crypto.webcrypto.subtle});
 w.URL.createObjectURL=b=>{const u='blob:fixture/'+(++blobId);blobs.set(u,b);return u;};w.URL.revokeObjectURL=u=>blobs.delete(u);
 class Media extends w.EventTarget{
  constructor(){super();this.src='';this.readyState=0;this.currentTime=0;this.duration=2;this.paused=true;this.loop=false;media.push(this);}
  getAttribute(n){return n==='src'?this.src:null;}removeAttribute(n){if(n==='src')this.src='';}
  load(){this.readyState=this.src?1:0;}pause(){this.paused=true;}
  async play(){if(autoplayBlocked)throw new w.DOMException('Blocked','NotAllowedError');this.paused=false;}
  finish(){if(this.loop){this.currentTime=0;this.dispatchEvent(new w.Event('timeupdate'));}else{this.currentTime=this.duration;this.paused=true;this.dispatchEvent(new w.Event('ended'));}}
 }
 w.Audio=Media;
 const bytes=Buffer.from('test-media-bytes'),hash=crypto.createHash('sha256').update(bytes).digest('hex');const catalog={schemaVersion:1,translation:core.TRANSLATION,chapters:{}},manifests={};
 for(const [b,c]of [[40,1],[40,2]]){const base=`${core.REPO}/releases/download/audio-${b}-${String(c).padStart(3,'0')}-fixture/`,count=core.books[b-1].verses[c-1],key=`${b}:${c}`;
  catalog.chapters[key]={bookId:b,chapter:c,revision:'fixture',sourceHash:'fixture',manifestUrl:base+'chapter.json'};
  manifests[key]={schemaVersion:1,translation:core.TRANSLATION,bookId:b,chapter:c,revision:'fixture',sourceHash:'fixture',expectedVerses:Array.from({length:count},(_,i)=>i+1),verses:Array.from({length:count},(_,i)=>({verse:i+1,duration:2,sha256:hash,url:base+`verse-${String(i+1).padStart(3,'0')}.mp3`}))};}
 w.fetch=async url=>{fetches.push(url);if(url===core.CATALOG_URL)return new Response(JSON.stringify(missing?{...catalog,chapters:{}}:catalog));
  const m=url.match(/audio-(\d+)-(\d+)-fixture\/(.*)$/);assert.ok(m);if(m[3]==='chapter.json')return new Response(JSON.stringify(manifests[`${Number(m[1])}:${Number(m[2])}`]));
  return new Response(corrupt&&m[3]==='verse-001.mp3'?'damaged':bytes);};
 for(const n of ['lib/books.js','lib/core.js','player.js'])load(w,n);
 const emit=(type,data={})=>w.dispatchEvent(new w.MessageEvent('message',{source:parent,origin,data:{channel:'RB_AUDIO',token,type,...data}}));
 const get=id=>w.document.getElementById(id);
 const seek=value=>{get('seek').value=String(value);get('seek').dispatchEvent(new w.Event('input'));get('seek').dispatchEvent(new w.Event('change'));};
 return {dom,w,emit,get,seek,messages,media,fetches,blobs};
}
test('player prefetches all 25 files with checksums before enabling play; pause and seek select the proper verse',async()=>{
 const h=playerHarness();await until(()=>h.messages.some(m=>m.type==='READY'));h.emit('LOAD',{context:{bookId:40,chapter:1,view:'biblereader'},mappingComplete:true});await until(()=>!h.get('play').disabled);
 assert.equal(h.fetches.filter(u=>u.endsWith('.mp3')).length,25);assert.equal(h.blobs.size,25);assert.equal(h.media[0].paused,true);
 h.get('play').click();await until(()=>h.get('status').textContent.startsWith('Spelar'));assert.equal(h.messages.filter(m=>m.type==='VERSE').at(-1).verse,1);
 h.get('play').click();assert.equal(h.media[0].paused,true);h.seek(18.5);await until(()=>h.messages.filter(m=>m.type==='VERSE').at(-1).verse===10);
 assert.match(h.get('verse').textContent,/Vers 10/);assert.equal(h.media[0].paused,true);assert.equal(h.media[0].currentTime,.5);
 h.emit('STOP');assert.equal(h.blobs.size,0);assert.equal(h.media[0].paused,true);h.dom.window.close();
});
test('player chapter loop restarts verse 1, verse loop stays selected, and loop off requests next chapter',async()=>{
 const h=playerHarness();await until(()=>h.messages.some(m=>m.type==='READY'));h.emit('LOAD',{context:{bookId:40,chapter:1,view:'studyb'},mappingComplete:true});await until(()=>!h.get('play').disabled);
 h.get('loop').click();h.seek(49.9);await sleep(10);h.get('play').click();await sleep(10);h.media[0].finish();await until(()=>h.messages.filter(m=>m.type==='VERSE').at(-1).verse===1);
 assert.equal(h.messages.some(m=>m.type==='NEXT'),false);h.get('play').click();h.get('loop').click();h.seek(12.1);await sleep(10);h.get('play').click();await sleep(10);
 assert.equal(h.media[0].loop,true);h.media[0].finish();assert.match(h.get('loop').textContent,/vers 7/);
 h.get('play').click();h.get('loop').click();h.seek(49.9);await sleep(10);h.get('play').click();await sleep(10);h.media[0].finish();
 await until(()=>h.messages.some(m=>m.type==='NEXT'));assert.equal(h.messages.find(m=>m.type==='NEXT').target.chapter,2);h.emit('STOP');h.dom.window.close();
});
test('autoplay continuation is requested after full prefetch, while blocked autoplay leaves a usable play control',async()=>{
 for(const blocked of [false,true]){const h=playerHarness({autoplayBlocked:blocked});await until(()=>h.messages.some(m=>m.type==='READY'));h.emit('LOAD',{context:{bookId:40,chapter:2,view:'studyb'},autoplay:true,mappingComplete:true});
 await until(()=>h.get('status').textContent.includes(blocked?'Tryck på spela':'Spelar'));assert.equal(h.fetches.filter(u=>u.endsWith('.mp3')).length,23);assert.equal(h.get('play').disabled,false);assert.equal(h.media[0].paused,blocked);h.emit('STOP');h.dom.window.close();}
});
test('missing or corrupted audio never becomes playable',async()=>{
 for(const opts of [{missing:true},{corrupt:true}]){const h=playerHarness(opts);await until(()=>h.messages.some(m=>m.type==='READY'));h.emit('LOAD',{context:{bookId:40,chapter:1,view:'biblereader'},mappingComplete:true});
 await until(()=>!h.get('retry').hidden);assert.equal(h.get('play').disabled,true);assert.equal(h.blobs.size,0);assert.equal(h.media[0].paused,true);h.emit('STOP');h.dom.window.close();}
});
test('service worker continuation is single-use, tab-scoped and refuses a different view or chapter',async()=>{
 const values=new Map();let receive;
 const sandbox={URL,DOMException,Date,setTimeout,clearTimeout,console,chrome:{runtime:{id:'test-extension',onMessage:{addListener:fn=>receive=fn}},storage:{session:{get:async key=>({[key]:values.get(key)}),set:async entries=>{for(const [k,v]of Object.entries(entries))values.set(k,v);},remove:async key=>values.delete(key)}},tabs:{onRemoved:{addListener:()=>{}}}}};
 vm.createContext(sandbox);sandbox.importScripts=(...names)=>{for(const name of names)vm.runInContext(read(name),sandbox);};vm.runInContext(read('background.js'),sandbox);
 const sender={id:'test-extension',frameId:0,tab:{id:3},url:'https://bibelonline.se/biblereader.php'};
 const call=(message,s=sender)=>new Promise(resolve=>{const handled=receive(message,s,resolve);if(!handled)resolve(null);});
 const current={bookId:40,chapter:1,view:'biblereader'},target={...current,chapter:2};
 assert.equal((await call({type:'RB_CONTINUE',current,target})).ok,true);
 assert.equal((await call({type:'RB_CONSUME_CONTINUATION',context:target},{...sender,tab:{id:4}})).autoplay,false);
 assert.equal((await call({type:'RB_CONSUME_CONTINUATION',context:target})).autoplay,true);
 assert.equal((await call({type:'RB_CONSUME_CONTINUATION',context:target})).autoplay,false);
 await call({type:'RB_CONTINUE',current,target});assert.equal((await call({type:'RB_CONSUME_CONTINUATION',context:{...target,view:'studyb'}})).autoplay,false);
 assert.equal((await call({type:'RB_CONTINUE',current,target:{...target,chapter:5}})).ok,false);
 assert.equal(await call({type:'RB_CONTINUE',current,target},{...sender,url:'https://evil.test/biblereader.php'}),null);
});
