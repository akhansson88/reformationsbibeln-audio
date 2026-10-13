/* End-to-end verification in an isolated development browser, never the user's profile. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { chromium } = require(require.resolve('playwright', { paths: [process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES || process.cwd(), process.cwd()] }));
const core = require('../lib/core.js');
const extension = path.resolve(__dirname, '..');
const output = process.env.RB_TEST_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'rb-audio-test-'));
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-chrome-profile-'));
const audioPath = path.join(output, 'test-verse.mp3');
const makeAudio = spawnSync('ffmpeg', ['-v','error','-y','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','0.6','-ac','1','-b:a','128k',audioPath]);
assert.equal(makeAudio.status, 0, makeAudio.stderr?.toString());
const mp3 = fs.readFileSync(audioPath);
const duration = Number(spawnSync('ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',audioPath],{encoding:'utf8'}).stdout.trim());
const sha256 = crypto.createHash('sha256').update(mp3).digest('hex');
const revision = 'browser-test';
const chapterContexts = [[40,1],[40,2],[40,28],[41,1],[19,117],[19,118],[66,22]];
const catalog = {schemaVersion:1,translation:core.TRANSLATION,chapters:{}};
const manifests = {};
for (const [bookId,chapter] of chapterContexts) {
  const key = `${bookId}:${chapter}`, base = `${core.REPO}/releases/download/audio-${String(bookId).padStart(2,'0')}-${String(chapter).padStart(3,'0')}-${revision}/`;
  const count = core.books[bookId-1].verses[chapter-1];
  catalog.chapters[key] = {bookId,chapter,revision,sourceHash:'fixture',manifestUrl:base+'chapter.json'};
  manifests[key] = {schemaVersion:1,translation:core.TRANSLATION,bookId,chapter,revision,sourceHash:'fixture',expectedVerses:Array.from({length:count},(_,i)=>i+1),verses:Array.from({length:count},(_,i)=>({verse:i+1,duration,sha256,url:base+`verse-${String(i+1).padStart(3,'0')}.mp3`}))};
}
const escaped = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function fixture(view, bookId, chapter, hiddenNumbers = false, strongs = false) {
  const c={view,bookId,chapter}, count=core.books[bookId-1].verses[chapter-1];
  const href=(b,n)=>`https://bibelonline.se/fromgettopost.php?prog=${view}&book=${b}&chap=${n}&col=ffe&txt=1.112&rub=yes&vnum=${hiddenNumbers?'no':'yes'}&font=Verdana${strongs?'&SN=yes':''}`;
  const chapterLinks=Array.from({length:core.books[bookId-1].verses.length},(_,i)=>`<a href="${escaped(href(bookId,i+1))}">${i+1}</a>`).join('');
  const bookLinks=core.books.map(b=>`<a href="${escaped(href(b.id,1))}">${escaped(b.abbreviation)}</a>`).join('');
  const text=n=>`${n===1?'Detta är boken om Jesu Kristi, Davids sons, Abrahams sons, släkttavla.':'Text för vers '+n+'.'} Här fortsätter den svenska bibeltexten för att testa radbrytningar och automatisk rullning.`;
  const verseRows = Array.from({length:count},(_,i)=>{
    const n=i+1;
    if(view==='studyb') return `<tr class="mytr"><td class="mytd" valign="top"><span class="locmyspan"><small>${n}</small></span></td><td class="myspan" style="border-right:1px solid #eee;line-height:1.2;text-align:justify"><span class="locmyspan">${escaped(text(n))}${strongs?' <a href="#strong">G2424</a>':''}</span></td><td class="mytd" valign="bottom"><span class="tooltip_strong"><a href="#reference">[r]</a></span></td><td class="mytd" valign="bottom"></td></tr>`;
    return `${i===4?'<br><span style="font-family:Verdana;font-size:1.112rem;color:#999"><b>En underrubrik</b></span><br>':''}${hiddenNumbers?'':`<span style="color:#000"><small><sup>${n}</sup></small>&nbsp;</span>`}<span style="font-family:Verdana;font-size:1.112rem">${escaped(text(n))}</span> `;
  }).join('');
  const body=view==='studyb'?`<table class="mytable1" cellpadding="10" width="100%"><tbody><tr><td colspan="4">Kapitlets rubrik</td></tr>${verseRows}</tbody></table>`:`<table class="mytable"><tbody><tr><td><span style="font-family:Verdana;font-size:1.112rem;color:#777"><b>Kapitlets rubrik</b></span><br><br>${verseRows}</td></tr></tbody></table>`;
  const share=`https://bibelonline.se/fromgettopost.php?prog=${view}&book=${bookId}&chap=${chapter}`;
  return `<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${view==='studyb'?'Studera':'Läs'} Bibeln</title><style>body{background:#fff7d8;color:#222;font:18px Verdana;margin:24px auto;max-width:920px;padding:0 18px}td{line-height:1.7}h1{font-size:20px}#Demo,#Demo2{display:none}.mytable1{border-collapse:collapse;background:#fffdf6}.mytr td{padding-top:24px;padding-bottom:24px;border-bottom:1px solid #eee}.mytable{line-height:2;background:#fffdf6}</style></head><body><a href="/bibelindex.php">Startsidan</a><h1>${escaped(core.chapterLabel(c))}</h1><div id="Demo">${bookLinks}</div><div id="Demo2">${chapterLinks}</div><a href="mailto:?subject=${encodeURIComponent(core.chapterLabel(c))}&amp;body=${encodeURIComponent(share)}">Dela kapitel</a>${body}</body></html>`;
}
const cases=[], errors=[], requests=[];
let corrupt=false, missing=false, transient=false, attemptedRetry=false;
const savedReports=new Map();let rejectNextReport=false;
let browser;
async function test(name, fn) {
  await fn(); cases.push({name,passed:true}); console.log('PASS '+name);
}
async function playerFrame(page) {
  await page.locator('#rb-audio-dock').waitFor();
  // Resolve the iframe mounted in the active document, rather than a named
  // frame that Chromium may retain for a previous document's back/forward cache.
  const handle=await page.locator('#rb-audio-dock iframe').elementHandle();
  const frame=await handle.contentFrame();
  assert.ok(frame,'Extension player iframe was mounted');
  await frame.locator('#chapter').waitFor();
  return frame;
}
async function ready(page, view='biblereader', bookId=40, chapter=1, extra='') {
  await page.goto(`https://bibelonline.se/${view}.php?book=${bookId}&chap=${chapter}${extra}`);
  const frame=await playerFrame(page);
  await frame.waitForFunction(()=>!document.getElementById('play').disabled,{timeout:20000});
  return frame;
}
async function seek(frame, seconds) {
  await frame.locator('#seek').evaluate((e,value)=>{e.value=String(value);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));},seconds);
}
async function marked(page, n) {
  await page.waitForFunction(n=>{
    const nodes=[...document.querySelectorAll('[data-rb-spoken="true"]')];
    return nodes.some(e=>e.textContent.trim()===String(n)||e.textContent.startsWith('Text för vers '+n+'.')||(n===1&&e.textContent.startsWith('Detta är boken')));
  },n,{timeout:10000});
}
(async()=>{
  browser=await chromium.launchPersistentContext(profile,{
    headless:true,channel:'chromium',executablePath:process.env.RB_CHROMIUM_EXECUTABLE || undefined, viewport:{width:1280,height:900},
    args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--no-sandbox'],
  });
  const seconds=Math.floor(Date.now()/1000),encode=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
  const jwt=encode({alg:'none',typ:'JWT'})+'.'+encode({iss:'https://securetoken.google.com/reformationsbibeln-fel',aud:'reformationsbibeln-fel',sub:'browser-listener',user_id:'browser-listener',iat:seconds,exp:seconds+3600,auth_time:seconds,firebase:{sign_in_provider:'anonymous'}})+'.signature';
  await browser.route('https://identitytoolkit.googleapis.com/**',route=>{
    const url=route.request().url();
    const body=url.includes('accounts:signUp')?{localId:'browser-listener',idToken:jwt,refreshToken:'test-token',expiresIn:'3600'}:url.includes('accounts:lookup')?{users:[{localId:'browser-listener',providerUserInfo:[],createdAt:String(Date.now()),lastLoginAt:String(Date.now())}]}:null;
    if(!body)return route.abort();return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  await browser.route('https://securetoken.googleapis.com/**',route=>route.abort());
  await browser.route('https://firestore.googleapis.com/**',route=>{
    const url=route.request().url(),body=route.request().postDataJSON(),time=new Date().toISOString();
    if(url.includes('/documents:commit')){
      if(rejectNextReport){rejectNextReport=false;return route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:{status:'PERMISSION_DENIED',message:'Test failure'}})});}
      const write=body.writes[0];savedReports.set(write.update.name,write);
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({commitTime:time,writeResults:[{updateTime:time,transformResults:[{timestampValue:time}]}]})});
    }
    if(url.includes('/documents:batchGet')){
      const name=body.documents[0],saved=savedReports.get(name),result=saved?{found:{name,fields:saved.update.fields,createTime:time,updateTime:time},readTime:time}:{missing:name,readTime:time};
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify([result])});
    }
    return route.abort();
  });
  await browser.route('https://bibelonline.se/**',async route=>{
    const u=new URL(route.request().url());
    if(u.pathname==='/fromgettopost.php') {
      const target=`https://bibelonline.se/${u.searchParams.get('prog')}.php?book=${u.searchParams.get('book')}&chap=${u.searchParams.get('chap')}`;
      // Playwright routes only the first URL of an HTTP redirect chain. A fresh
      // client navigation keeps the destination fixture intercepted as well.
      return route.fulfill({status:200,contentType:'text/html',body:`<!doctype html><script>location.replace(${JSON.stringify(target)})</script>`});
    }
    if(['/biblereader.php','/studyb.php'].includes(u.pathname)) return route.fulfill({status:200,contentType:'text/html',body:fixture(u.pathname.slice(1,-4),Number(u.searchParams.get('book')||40),Number(u.searchParams.get('chap')||1),u.searchParams.get('hide')==='1',u.searchParams.get('strong')==='1')});
    return route.fulfill({status:200,contentType:'text/html',body:'<html><body>Startsidan</body></html>'});
  });
  await browser.route('https://raw.githubusercontent.com/**',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(missing?{...catalog,chapters:{}}:catalog)}));
  await browser.route('https://github.com/akhansson88/reformationsbibeln-audio/releases/download/**',async route=>{
    const u=new URL(route.request().url()),m=u.pathname.match(/audio-(\d+)-(\d+)-browser-test\/(chapter\.json|verse-(\d+)\.mp3)$/);
    assert.ok(m,'All release requests are constrained to the fixture repository');
    const key=`${Number(m[1])}:${Number(m[2])}`;
    if(m[3]==='chapter.json') return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(manifests[key])});
    requests.push({key,verse:Number(m[4])});
    if(transient&&!attemptedRetry){attemptedRetry=true;return route.fulfill({status:503,body:'Retry'});}
    return route.fulfill({status:200,contentType:'audio/mpeg',body:corrupt&&Number(m[4])===1?Buffer.from('corrupt'):mp3});
  });
  const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.stack||e.message));
  // Remaining checks are sequential: each begins with a new chapter session.
  for(const view of ['biblereader','studyb']) {
    await test(`${view}: complete prefetch, playback and pause`,async()=>{
      const before=requests.length;
      const frame=await ready(page,view);
      const downloaded=requests.slice(before).filter(r=>r.key==='40:1');
      assert.equal(new Set(downloaded.map(r=>r.verse)).size,25);
      assert.equal(await page.locator('[data-rb-spoken="true"]').count(),0);
      await frame.locator('#play').click();await marked(page,1);
      await frame.waitForFunction(()=>document.getElementById('status').textContent.startsWith('Spelar'));
      await frame.locator('#play').click();
      assert.equal(await frame.locator('#play').getAttribute('aria-label'),'Spela');
      await seek(frame,duration*9+.04);await marked(page,10);
      assert.match(await frame.locator('#verse').innerText(),/Vers 10 av 25/);
      assert.equal(await frame.locator('#play').getAttribute('aria-label'),'Spela','Seeking while paused must remain paused');
      const box=await frame.locator('#seek').boundingBox();
      await page.mouse.move(box.x+box.width*.66,box.y+box.height/2);
      assert.match(await frame.locator('#tooltip').innerText(),/^Vers \d+ · /);
      await frame.locator('#follow').click();
      // The follow message crosses the iframe boundary asynchronously. Let the
      // parent cancel the prior smooth scroll before measuring a new baseline.
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const scrollBefore=await page.evaluate(()=>window.scrollY);
      await seek(frame,duration*22+.04);await marked(page,23);
      assert.equal(await page.evaluate(()=>window.scrollY),scrollBefore,'Follow off must preserve manual scrolling');
      await frame.locator('#follow').click();
      await page.waitForFunction(()=>{const e=[...document.querySelectorAll('[data-rb-spoken="true"]')].find(e=>e.textContent.startsWith('Text för vers'));if(!e)return false;const r=e.getBoundingClientRect();const frame=document.getElementById('rb-audio-dock').getBoundingClientRect();return r.top>=0&&r.bottom<=frame.top+3;});
      await page.screenshot({path:path.join(output,`${view}-player.png`)});
    });
    await test(`${view}: chapter and verse loops`,async()=>{
      const frame=await ready(page,view);
      await frame.locator('#loop').click();assert.equal(await frame.locator('#loop').innerText(),'Loop: kapitel');
      await seek(frame,Number(await frame.locator('#seek').getAttribute('max'))-.04);
      await frame.locator('#play').click();await marked(page,1);
      assert.ok(page.url().includes(`${view}.php?book=40&chap=1`));
      await frame.locator('#play').click();
      await frame.locator('#loop').click();
      await seek(frame,duration*6+.04);await marked(page,7);
      await frame.locator('#play').click();
      await new Promise(r=>setTimeout(r,1500));
      assert.match(await frame.locator('#loop').innerText(),/Loop: vers 7/);
      assert.match(await frame.locator('#verse').innerText(),/Vers 7 av 25/);
      await frame.locator('#play').click();await frame.locator('#loop').click();
      assert.equal(await frame.locator('#loop').innerText(),'Loop: av');
    });
    await test(`${view}: automatic next chapter and manual view change stops audio`,async()=>{
      let frame=await ready(page,view);
      await seek(frame,Number(await frame.locator('#seek').getAttribute('max'))-.04);
      await frame.locator('#play').click();
      await page.waitForURL(`https://bibelonline.se/${view}.php?book=40&chap=2`,{timeout:15000});
      frame=await playerFrame(page);
      await frame.waitForFunction(()=>document.getElementById('status').textContent.startsWith('Spelar'),undefined,{timeout:20000});
      assert.match(await frame.locator('#chapter').innerText(),/ 2$/);
      assert.equal(await frame.locator('#play').getAttribute('aria-label'),'Pausa');
      const other=view==='studyb'?'biblereader':'studyb';
      const nextFrame=await ready(page,other,40,2);
      assert.equal(await nextFrame.locator('#play').getAttribute('aria-label'),'Spela');
      assert.equal(await page.locator('[data-rb-spoken="true"]').count(),0);
      assert.equal(frame.isDetached(),true,'Old player and its audio must be destroyed');
    });
    await test(`${view}: pronunciation report marks words, validates description, pauses and retries safely`,async()=>{
      const frame=await ready(page,view,40,1,'&strong=1');await seek(frame,duration*6+.04);await marked(page,7);
      await frame.locator('#play').click();await frame.locator('#report').click();await frame.locator('#report-dialog').waitFor({state:'visible'});
      await frame.waitForFunction(()=>document.querySelectorAll('#report-words button').length>0);
      assert.equal(await frame.locator('#report-verse').inputValue(),'7');assert.equal(await frame.locator('#play').getAttribute('aria-label'),'Spela');
      assert.doesNotMatch(await frame.locator('#report-words').innerText(),/G2424/);
      const before=savedReports.size;await frame.locator('#report-description').fill('   ');await frame.locator('#report-submit').click();
      await frame.locator('#report-error').waitFor({state:'visible'});assert.equal(savedReports.size,before);
      await frame.locator('#report-words button').nth(0).click();await frame.locator('#report-words button').nth(1).click();
      assert.equal(await frame.locator('#report-description').getAttribute('required'),null);await frame.locator('#report-description').fill('Beskrivning av uttalet.');
      rejectNextReport=true;await frame.locator('#report-submit').click();await frame.locator('#report-error').waitFor({state:'visible'});
      assert.equal(await frame.locator('#report-description').inputValue(),'Beskrivning av uttalet.');assert.equal(await frame.locator('#report-words button[aria-pressed="true"]').count(),2);
      await frame.locator('#report-submit').click();await frame.locator('#report-success').waitFor({state:'visible'});assert.equal(savedReports.size,before+1);
      const write=[...savedReports.values()].at(-1);assert.equal(write.update.fields.verse.integerValue,'7');assert.equal(Object.keys(write.update.fields.selectedWords.mapValue.fields).length,2);
      assert.equal(write.updateTransforms[0].setToServerValue,'REQUEST_TIME');assert.match(write.update.fields.audioUrl.stringValue,/verse-007\.mp3$/);
      await frame.locator('#report-done').click();await frame.locator('#report-dialog').waitFor({state:'hidden'});assert.equal(await frame.locator('#play').getAttribute('aria-label'),'Spela');
    });
  }
  await test('reader without visible verse numbers still maps all text spans',async()=>{
    const frame=await ready(page,'biblereader',40,1,'&hide=1');
    assert.match(await frame.locator('#status').innerText(),/Klart att spela/);
    await seek(frame,duration*4+.04);await marked(page,5);
    assert.equal(await page.locator('[data-rb-spoken="true"]').count(),1);
  });
  await test('study references and Strongs links remain usable during highlighting',async()=>{
    const frame=await ready(page,'studyb',40,1,'&strong=1');await seek(frame,duration*4+.04);await marked(page,5);
    assert.equal(await page.locator('a[href="#reference"]').count(),25);
    assert.equal(await page.locator('a[href="#strong"]').count(),25);
    assert.equal(await page.locator('tr.mytr:nth-of-type(6) td:nth-child(3)[data-rb-spoken]').count(),0);
  });
  await test('automatic continuation crosses a Bible book boundary',async()=>{
    let frame=await ready(page,'studyb',40,28);
    await seek(frame,Number(await frame.locator('#seek').getAttribute('max'))-.04);await frame.locator('#play').click();
    await page.waitForURL('https://bibelonline.se/studyb.php?book=41&chap=1',{timeout:15000});
    frame=await playerFrame(page);await frame.waitForFunction(()=>document.getElementById('status').textContent.startsWith('Spelar'),undefined,{timeout:20000});
    assert.match(await frame.locator('#chapter').innerText(),/Markus/);
  });
  await test('the last chapter stops at the end of the Bible',async()=>{
    const frame=await ready(page,'biblereader',66,22);
    await seek(frame,Number(await frame.locator('#seek').getAttribute('max'))-.04);await frame.locator('#play').click();
    await frame.waitForFunction(()=>document.getElementById('status').textContent.includes('Bibeln är slut'));
    assert.equal(page.url(),'https://bibelonline.se/biblereader.php?book=66&chap=22');
  });
  await test('missing chapter disables play and explains the missing recording',async()=>{
    missing=true;await page.goto('https://bibelonline.se/biblereader.php?book=40&chap=1');
    const frame=await playerFrame(page);await frame.waitForFunction(()=>document.getElementById('status').textContent.includes('Ljud saknas'));
    assert.equal(await frame.locator('#play').isDisabled(),true);missing=false;
  });
  await test('checksum failure blocks playback and retry recovers the entire chapter',async()=>{
    corrupt=true;await page.goto('https://bibelonline.se/studyb.php?book=40&chap=1');
    const frame=await playerFrame(page);await frame.waitForFunction(()=>document.getElementById('status').textContent.includes('integritetskontrollen'));
    assert.equal(await frame.locator('#play').isDisabled(),true);corrupt=false;await frame.locator('#retry').click();
    await frame.waitForFunction(()=>!document.getElementById('play').disabled);
    assert.equal(await frame.locator('#download').innerText(),'');
  });
  await test('a transient failed download is retried before playback is enabled',async()=>{
    transient=true;attemptedRetry=false;await ready(page);
    assert.equal(attemptedRetry,true);transient=false;
  });
  await test('fixed player fits a narrow window without horizontal overflow or clipped controls',async()=>{
    await page.setViewportSize({width:390,height:844});const frame=await ready(page,'studyb');
    await frame.waitForFunction(()=>document.querySelector('.player').getBoundingClientRect().height<=innerHeight+2);
    const dimensions=await frame.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,height:innerHeight,playerHeight:document.querySelector('.player').getBoundingClientRect().height}));
    assert.ok(dimensions.scrollWidth<=dimensions.width,JSON.stringify(dimensions));
    assert.ok(dimensions.playerHeight<=dimensions.height+2,JSON.stringify(dimensions));
    assert.equal(await frame.locator('#follow').isVisible(),true);assert.equal(await frame.locator('#loop').isVisible(),true);
    await page.screenshot({path:path.join(output,'narrow-player.png')});
    await frame.locator('#report').click();await frame.locator('#report-dialog').waitFor({state:'visible'});
    const dialog=await frame.locator('#report-dialog').boundingBox();assert.ok(dialog.x>=0&&dialog.x+dialog.width<=390&&dialog.y>=0&&dialog.y+dialog.height<=844,JSON.stringify(dialog));
    await page.screenshot({path:path.join(output,'narrow-report.png')});await frame.locator('#report-cancel').click();
  });
  assert.deepEqual(errors,[],'The browser must not report uncaught page errors');
  const report={passed:true,tests:cases,errors,mp3Requests:requests.length,output};
  fs.writeFileSync(path.join(output,'browser-report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
})().catch(async error=>{
  const states=[];
  for(const p of browser?.pages()||[])for(const f of p.frames())if(f.name()==='rb-audio-player'){
    try{states.push({pageUrl:p.url(),...await f.evaluate(()=>({url:location.href,status:document.getElementById('status')?.textContent,chapter:document.getElementById('chapter')?.textContent,verse:document.getElementById('verse')?.textContent,reportError:document.getElementById('report-error')?.textContent}))});}catch{}
  }
  console.error('Player state at failure: '+JSON.stringify(states));
  fs.writeFileSync(path.join(output,'browser-report.json'),JSON.stringify({passed:false,tests:cases,errors,states,error:error.stack},null,2));
  console.error(error);process.exitCode=1;
}).finally(async()=>{await browser?.close();});
