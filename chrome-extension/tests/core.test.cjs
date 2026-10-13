const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../lib/core.js');

test('canonical chapter boundaries include transitions to the next book and the end of Revelation', () => {
  assert.equal(core.books.length, 66);
  assert.equal(core.books.reduce((n,b)=>n+b.verses.length,0),1189);
  assert.deepEqual(core.nextChapter({bookId:40,chapter:28,view:'studyb'}),{bookId:41,chapter:1,view:'studyb'});
  assert.equal(core.nextChapter({bookId:66,chapter:22,view:'biblereader'}),null);
  assert.equal(core.validContext({bookId:40,chapter:29,view:'studyb'}),false);
});
test('a continuous chapter timeline seeks at exact verse boundaries and clamps both ends',()=>{
  const clock=core.timeline([{verse:1,duration:5},{verse:2,duration:3},{verse:3,duration:7}]);
  assert.deepEqual(core.positionAt(clock,5),{index:1,verse:2,offset:0,seconds:5});
  assert.equal(core.positionAt(clock,-5).verse,1);
  assert.deepEqual(core.positionAt(clock,100),{index:2,verse:3,offset:7,seconds:15});
  assert.equal(core.positionAt(clock,7).offset,2);
});
test('loop overrides automatic continuation and verse loop repeats the selected verse',()=>{
  assert.deepEqual(core.finishAction('verse',1,3),{type:'track',index:1});
  assert.deepEqual(core.finishAction('chapter',2,3),{type:'track',index:0});
  assert.deepEqual(core.finishAction('off',2,3),{type:'nextChapter'});
  assert.deepEqual(core.finishAction('off',0,3),{type:'track',index:1});
});
test('audio manifests must contain the complete chapter in order and only this repo release assets',()=>{
  const c={bookId:19,chapter:117,view:'biblereader'}, revision='testrevision';
  const base=`${core.REPO}/releases/download/audio-19-117-${revision}/`;
  const catalog={schemaVersion:1,translation:core.TRANSLATION,chapters:{'19:117':{bookId:19,chapter:117,revision,sourceHash:'abc',manifestUrl:base+'chapter.json'}}};
  const e=core.chapterEntry(catalog,c);
  const m={schemaVersion:1,translation:core.TRANSLATION,bookId:19,chapter:117,revision,sourceHash:'abc',expectedVerses:[1,2],verses:[1,2].map(verse=>({verse,duration:4,sha256:'a'.repeat(64),url:base+`verse-${String(verse).padStart(3,'0')}.mp3`}))};
  assert.equal(core.validateManifest(m,e,c).length,2);
  assert.throws(()=>core.validateManifest({...m,verses:m.verses.slice(0,1)},e,c));
  assert.throws(()=>core.validateManifest({...m,verses:[m.verses[1],m.verses[0]]},e,c));
  assert.throws(()=>core.validateManifest({...m,verses:[{...m.verses[0],url:'https://example.com/audio.mp3'},m.verses[1]]},e,c));
  assert.throws(()=>core.chapterEntry({...catalog,chapters:{'19:117':{...catalog.chapters['19:117'],manifestUrl:'https://example.com/chapter.json'}}},c));
  assert.equal(core.chapterEntry({...catalog,chapters:{}},c),null);
  const early={bookId:1,chapter:1,view:'biblereader'};
  const earlyURL=`${core.REPO}/releases/download/audio-01-001-${revision}/chapter.json`;
  const earlyCatalog={...catalog,chapters:{'1:1':{bookId:1,chapter:1,revision,sourceHash:'abc',manifestUrl:earlyURL}}};
  assert.equal(core.chapterEntry(earlyCatalog,early).manifestUrl,earlyURL);
});
test('site permissions and one-shot continuation are limited to a known view and a short expiry',()=>{
  const c={bookId:43,chapter:2,view:'biblereader'};
  assert.equal(core.isSiteURL('https://bibelonline.se/biblereader.php',true),true);
  assert.equal(core.isSiteURL('https://bibelonline.se.evil.test/biblereader.php',true),false);
  assert.equal(core.isSiteURL('https://bibelonline.se/textfind.php',true),false);
  assert.equal(core.isSiteURL('http://bibelonline.se/studyb.php',true),false);
  assert.equal(core.continuationMatches({target:c,expiresAt:45000},c,1000),true);
  assert.equal(core.continuationMatches({target:c,expiresAt:45000},{...c,view:'studyb'},1000),false);
  assert.equal(core.continuationMatches({target:c,expiresAt:999},c,1000),false);
});
test('prefetch concurrency is bounded and results preserve verse order',async()=>{
  let active=0,peak=0;
  const values=await core.mapLimit([1,2,3,4,5,6,7],3,async value=>{
    active++;peak=Math.max(peak,active);await core.delay((8-value)*2);active--;return value*2;
  });
  assert.equal(peak,3);assert.deepEqual(values,[2,4,6,8,10,12,14]);
});
test('download retries honor transient responses while a missing verse is not repeatedly requested',async()=>{
  let calls=0;
  const transient=async()=>++calls===1?new Response('',{status:429,headers:{'retry-after':'0'}}):new Response('audio');
  const result=await core.fetchResponse('https://example.test',null,transient);
  assert.equal(await result.text(),'audio');assert.equal(calls,2);
  calls=0;
  await assert.rejects(core.fetchResponse('https://example.test',null,async()=>{calls++;return new Response('',{status:404});}),/404/);
  assert.equal(calls,1);
});
test('canceled downloads stop immediately, including a canceled retry delay',async()=>{
  const c=new AbortController();c.abort();let calls=0;
  await assert.rejects(core.fetchResponse('https://example.test',c.signal,async()=>{calls++;return new Response('');}),{name:'AbortError'});
  assert.equal(calls,0);
  const d=new AbortController();const work=core.delay(10000,d.signal);d.abort();await assert.rejects(work,{name:'AbortError'});
});
test('chapter time displays remain readable for short and long chapters',()=>{
  assert.equal(core.formatTime(65.9),'1:05');assert.equal(core.formatTime(3661),'1:01:01');
});
