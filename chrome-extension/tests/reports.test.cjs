const { test } = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const reports = require('../lib/reports.js'), core = require('../lib/core.js');
function input(overrides={}) { return {context:{bookId:1,chapter:1,view:'biblereader'},verse:1,
 audio:{revision:'fixture',url:`${core.REPO}/releases/download/audio-01-001-fixture/verse-001.mp3`,sha256:'a'.repeat(64)},
 verseText:'Gud sade Gud.', selectedIndices:[0], description:'',extensionVersion:'1.1.0',clientReportId:crypto.randomUUID(),...overrides}; }
test('report snapshots preserve punctuation and the occurrence of repeated words',()=>{
 const d=reports.buildDraft(input({verseText:'Gud sade Gud och Gud.',selectedIndices:[2,0,2]}));
 assert.deepEqual(d.selectedWords,{'0':'Gud','2':'Gud'});assert.equal(d.description,'');assert.equal(d.bookName,core.books[0].name);assert.equal(d.audioChecksum,'a'.repeat(64));
});
test('no words requires non-whitespace description; description-only and words-plus-description are valid',()=>{
 for(const description of ['', '  \n\t', '\u00a0\u2003\ufeff', '\u0085'])assert.throws(()=>reports.buildDraft(input({selectedIndices:[],description})),/Markera minst/);
 assert.equal(reports.buildDraft(input({selectedIndices:[],verseText:'',description:'  Hela versen saknas.  '})).description,'Hela versen saknas.');
 assert.equal(reports.buildDraft(input({selectedIndices:[0],description:'Uttala med långt u.'})).description,'Uttala med långt u.');
});
test('normalization retains Swedish letters and splits only at whitespace',()=>{
 assert.deepEqual(reports.words('  A\u0308r\u00a0det\nordet?  '),['Är','det','ordet?']);
 assert.equal(reports.buildDraft(input({verseText:'  A\u0308r\u00a0det ordet? ',selectedIndices:[0]})).selectedWords['0'],'Är');
});
test('rejects invalid references, indices, too-long text and mismatched audio metadata',()=>{
 for(const patch of [{verse:32},{selectedIndices:[3]},{selectedIndices:[-1]},{selectedIndices:['0']},{verseText:'x'.repeat(6001)},{description:'x'.repeat(1001)},
 {audio:{...input().audio,url:'https://evil.test/verse-001.mp3'}},{audio:{...input().audio,sha256:'invalid'}},{clientReportId:'bad'}])assert.throws(()=>reports.buildDraft(input(patch)));
});
test('all words may be marked without a small arbitrary selection limit',()=>{
 const verseText=Array.from({length:180},()=> 'ord').join(' '),selectedIndices=Array.from({length:180},(_,i)=>i);
 assert.equal(Object.keys(reports.buildDraft(input({verseText,selectedIndices})).selectedWords).length,180);
});
