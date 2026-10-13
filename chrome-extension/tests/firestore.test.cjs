const { test, before, beforeEach, after } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { collection, doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc, serverTimestamp, Timestamp } = require('firebase/firestore');
const core = require('../lib/core.js'), reports = require('../lib/reports.js');
let env;
// Compile the exact ASCII file delivered for direct pasting into Console.
before(async()=>{ env=await initializeTestEnvironment({projectId:'demo-reformationsbibeln-fel',firestore:{host:'127.0.0.1',port:8080,rules:fs.readFileSync(path.join(__dirname,'../firebase/reformationsbibeln-firestore-ascii.rules'),'utf8')}}); });
beforeEach(async()=>env.clearFirestore());
after(async()=>{if(env)await env.cleanup();});
const anon=uid=>env.authenticatedContext(uid,{firebase:{sign_in_provider:'anonymous'}}).firestore();
function report(uid='listener-a',overrides={}){
 const draft=reports.buildDraft({context:{bookId:1,chapter:1,view:'biblereader'},verse:1,audio:{revision:'fixture',url:`${core.REPO}/releases/download/audio-01-001-fixture/verse-001.mp3`,sha256:'a'.repeat(64)},
  verseText:'Gud sade Gud.',selectedIndices:[0],description:'',extensionVersion:'1.1.0',clientReportId:crypto.randomUUID()});
 return {...draft,reporterUid:uid,createdAt:serverTimestamp(),...overrides};
}
const ref=(db,d)=>doc(db,'pronunciationReports',`${d.reporterUid}_${d.clientReportId}`);
test('anonymous reports accept selected words, repeated occurrences and optional descriptions',async()=>{
 const db=anon('listener-a');for(const patch of [{},{selectedWords:{'0':'Gud','2':'Gud.'}},{description:'Långt u.'}]){const d=report('listener-a',patch);await assertSucceeds(setDoc(ref(db,d),d));}
});
test('unselected words require a non-whitespace description, including Unicode whitespace',async()=>{
 const db=anon('listener-a');for(const description of ['',' \n\t','\u00a0\u2003\ufeff','\u0085','\u202f\u205f\u3000\ufeff','\u1680\u2000\u200a','\u2028\u2029']){const d=report('listener-a',{selectedWords:{},description});await assertFails(setDoc(ref(db,d),d));}
 const d=report('listener-a',{selectedWords:{},verseText:'',description:'Sista meningen saknas.'});await assertSucceeds(setDoc(ref(db,d),d));
});
test('no login, another UID or a non-anonymous account cannot submit',async()=>{
 const d=report();await assertFails(setDoc(ref(env.unauthenticatedContext().firestore(),d),d));await assertFails(setDoc(ref(anon('other'),d),d));
 await assertFails(setDoc(ref(env.authenticatedContext('listener-a',{firebase:{sign_in_provider:'password'}}).firestore(),d),d));
});
test('only the submitting listener can read an exact receipt; listing, editing and deleting are denied',async()=>{
 const db=anon('listener-a'),d=report(),r=ref(db,d);await assertSucceeds(setDoc(r,d));
 assert.equal((await assertSucceeds(getDoc(r))).exists(),true);await assertFails(getDoc(ref(anon('other'),d)));await assertFails(getDoc(ref(env.unauthenticatedContext().firestore(),d)));
 await assertFails(getDocs(collection(db,'pronunciationReports')));await assertFails(updateDoc(r,{description:'Changed'}));await assertFails(deleteDoc(r));await assertFails(setDoc(r,d));
});
test('schema, server timestamp, status, lengths and word membership are validated',async()=>{
 const db=anon('listener-a');for(const patch of [
 {admin:true},{status:'fixed'},{createdAt:Timestamp.fromDate(new Date('2020-01-01'))},{description:'x'.repeat(1001)},
 {verseText:'x'.repeat(6001)},{selectedWords:{'0':'not in text'}},{selectedWords:{'bad':'Gud'}},
 {selectedWords:{'0':42}},{selectedWords:[]},{selectedWords:{'0':''},verseText:' '},{audioChecksum:'bad'},
 {audioUrl:'https://evil.test/verse-001.mp3'},{audioRevision:'bad/../revision'},{bookName:'Wrong book'},{chapter:51},{verse:32},{clientReportId:'not-a-uuid'}
 ]){const d=report('listener-a',patch);await assertFails(setDoc(ref(db,d),d));}
});
test('audio URL must match the report book, chapter, verse and revision',async()=>{
 const db=anon('listener-a');for(const url of [
 `${core.REPO}/releases/download/audio-02-001-fixture/verse-001.mp3`,`${core.REPO}/releases/download/audio-01-002-fixture/verse-001.mp3`,`${core.REPO}/releases/download/audio-01-001-fixture/verse-002.mp3`
 ]){const d=report('listener-a',{audioUrl:url});await assertFails(setDoc(ref(db,d),d));}
});
test('book and chapter boundaries, long Psalm 119 and marking an entire long verse remain valid',async()=>{
 const db=anon('listener-a');for(const [bookId,chapter]of [[1,50],[19,119],[66,22]]){
 const verse=core.books[bookId-1].verses[chapter-1],verseText=Array.from({length:180},()=> 'ord').join(' ');
 const selectedWords=Object.fromEntries(Array.from({length:180},(_,i)=>[String(i),'ord']));
 const d=report('listener-a',{bookId,bookName:core.books[bookId-1].name,chapter,verse,verseText,selectedWords,
 audioUrl:`${core.REPO}/releases/download/audio-${String(bookId).padStart(2,'0')}-${String(chapter).padStart(3,'0')}-fixture/verse-${String(verse).padStart(3,'0')}.mp3`});
 await assertSucceeds(setDoc(ref(db,d),d));}
});
test('all other collections stay inaccessible to extension clients',async()=>{
 const db=anon('listener-a');await assertFails(setDoc(doc(db,'settings','anything'),{enabled:true}));await assertFails(getDoc(doc(db,'settings','anything')));
});
test('all delivered rule files are identical ASCII Firestore source without a JSON wrapper or BOM',()=>{
 const native=fs.readFileSync(path.join(__dirname,'../firebase/firestore.rules'),'utf8');
 for(const name of ['firestore-rules.json','reformationsbibeln-firestore-ascii.rules'])assert.equal(fs.readFileSync(path.join(__dirname,'../firebase',name),'utf8'),native);
 assert.equal(native.split('\n')[0],"rules_version = '2';");assert.doesNotMatch(native,/[^\x00-\x7f]/);assert.throws(()=>JSON.parse(native),SyntaxError);
});
