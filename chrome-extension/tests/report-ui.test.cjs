const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');const core=require('../lib/core.js');const root=path.resolve(__dirname,'..');
const sleep=()=>new Promise(r=>setTimeout(r,0));
function harness({text='Gud sade Gud och Gud.',submit=async()=>({id:'test'}),requestText}={}){
 const dom=new JSDOM(fs.readFileSync(path.join(root,'player.html'),'utf8'),{url:'https://extension.test/',runScripts:'outside-only'}),w=dom.window,messages=[],sent=[];
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
 for(const name of ['lib/books.js','lib/core.js','lib/reports.js','report-ui.js'])w.eval(fs.readFileSync(path.join(root,name),'utf8'));
 const context={bookId:1,chapter:1,view:'biblereader'};let pauses=0;
 const report=w.RBAudioReportUI.create({pause:()=>pauses++,post:(type,data)=>messages.push({type,...data}),
 requestText:requestText|| (async()=>text),store:{submit:async draft=>{sent.push(draft);return submit(draft);}},
 getSnapshot:()=>({context,verse:1,revision:'fixture',version:'1.1.0',tracks:[1,2].map(verse=>({verse,url:`${core.REPO}/releases/download/audio-01-001-fixture/verse-${String(verse).padStart(3,'0')}.mp3`,sha256:'a'.repeat(64)}))})});
 const get=name=>w.document.getElementById(`report-${name}`),send=()=>get('form').dispatchEvent(new w.Event('submit',{cancelable:true,bubbles:true}));
 const description=value=>{get('description').value=value;get('description').dispatchEvent(new w.Event('input'));};
 return {dom,w,report,get,send,description,sent,messages,pauses:()=>pauses};
}
test('clicking words toggles individual occurrences and description becomes optional',async()=>{
 const h=harness();h.report.open();await sleep();assert.equal(h.pauses(),1);assert.equal(h.get('description').required,true);
 const buttons=h.get('words').querySelectorAll('button');buttons[0].click();buttons[2].click();assert.equal(h.get('description').required,false);
 buttons[0].click();h.send();await sleep();assert.deepEqual(JSON.parse(JSON.stringify(h.sent[0].selectedWords)),{'2':'Gud'});
 assert.equal(h.sent[0].description,'');assert.equal(h.get('success').hidden,false);h.dom.window.close();
});
test('whitespace-only description cannot replace word selection and absent text permits description-only report',async()=>{
 const h=harness({text:''});h.report.open();await sleep();h.description(' \u00a0\n');h.send();await sleep();assert.equal(h.sent.length,0);assert.equal(h.get('error').hidden,false);
 h.description('Ljudet hoppar över sista meningen.');h.send();await sleep();assert.deepEqual(JSON.parse(JSON.stringify(h.sent[0].selectedWords)),{});assert.equal(h.get('success').hidden,false);h.dom.window.close();
});
test('changing verse clears selections and description and ignores stale text response',async()=>{
 const pending=[];const h=harness({requestText:(c,v)=>new Promise(resolve=>pending.push({v,resolve}))});h.report.open();
 h.get('verse').value='2';h.get('verse').dispatchEvent(new h.w.Event('change'));
 pending[1].resolve('Vers två.');await sleep();pending[0].resolve('Gammal vers.');await sleep();assert.equal(h.get('words').textContent.trim(),'Vers två.');
 h.get('words').querySelector('button').click();h.description('Anteckning');h.get('verse').value='1';h.get('verse').dispatchEvent(new h.w.Event('change'));
 pending[2].resolve('Vers ett.');await sleep();assert.equal(h.get('description').value,'');assert.equal(h.get('description').required,true);assert.equal(h.get('selection').textContent,'Inga ord markerade');h.dom.window.close();
});
test('success is shown only after server acknowledgement and double-submit is ignored',async()=>{
 let accept;const h=harness({submit:()=>new Promise(resolve=>accept=resolve)});h.report.open();await sleep();h.get('words').querySelector('button').click();h.send();h.send();
 assert.equal(h.sent.length,1);assert.equal(h.get('submit').disabled,true);assert.equal(h.get('success').hidden,true);assert.match(h.get('state').textContent,/Skickar/);
 accept({id:'confirmed'});await sleep();assert.equal(h.get('success').hidden,false);h.dom.window.close();
});
test('failed submission retains data and unchanged retries keep the same report ID',async()=>{
 let calls=0;const h=harness({submit:async()=>{if(!calls++)throw new Error('Offline. Försök igen.');return {id:'ok'};}});h.report.open();await sleep();h.get('words').querySelector('button').click();h.description('Långt u.');h.send();await sleep();
 assert.equal(h.get('description').value,'Långt u.');assert.equal(h.get('words').querySelector('button').getAttribute('aria-pressed'),'true');assert.equal(h.get('success').hidden,true);assert.equal(h.get('submit').disabled,false);
 h.send();await sleep();assert.equal(h.sent[0].clientReportId,h.sent[1].clientReportId);assert.equal(h.get('success').hidden,false);h.get('done').click();assert.equal(h.get('dialog').open,false);h.dom.window.close();
});
test('verse text is rendered as text even when it contains HTML-like input',async()=>{
 const h=harness({text:'<img src=x onerror=alert(1)> Gud.'});h.report.open();await sleep();assert.equal(h.get('words').querySelector('img'),null);assert.match(h.get('words').textContent,/<img/);h.dom.window.close();
});
