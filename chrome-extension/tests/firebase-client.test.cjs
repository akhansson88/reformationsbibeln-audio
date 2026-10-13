const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {JSDOM}=require('jsdom');const reports=require('../lib/reports.js'),core=require('../lib/core.js');
const timestamp='2026-10-13T12:00:00.000000Z';
function draft(){return reports.buildDraft({context:{bookId:1,chapter:1,view:'studyb'},verse:1,
 audio:{revision:'fixture',url:`${core.REPO}/releases/download/audio-01-001-fixture/verse-001.mp3`,sha256:'a'.repeat(64)},
 verseText:'Gud sade Gud.',selectedIndices:[2],description:'Långt u.',extensionVersion:'1.1.0',clientReportId:crypto.randomUUID()});}
function harness(handleCommit){
 const dom=new JSDOM('<!doctype html>',{url:'https://extension.test/',runScripts:'outside-only'}),w=dom.window,calls=[];let savedName=null;
 for(const name of ['Headers','Request','Response','TextEncoder','TextDecoder','AbortController'])w[name]=globalThis[name];
 const seconds=Math.floor(Date.now()/1000),encode=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
 const jwt=encode({alg:'none',typ:'JWT'})+'.'+encode({iss:'https://securetoken.google.com/reformationsbibeln-fel',aud:'reformationsbibeln-fel',sub:'listener-test',user_id:'listener-test',iat:seconds,exp:seconds+3600,auth_time:seconds,firebase:{sign_in_provider:'anonymous'}})+'.signature';
 const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
 w.fetch=async(url,options={})=>{
  const body=options.body?JSON.parse(options.body):null;calls.push({url:String(url),options,body});
  if(String(url).includes('identitytoolkit.googleapis.com/v1/accounts:signUp'))return response({localId:'listener-test',idToken:jwt,refreshToken:'test-refresh-token',expiresIn:'3600'});
  if(String(url).includes('identitytoolkit.googleapis.com/v1/accounts:lookup'))return response({users:[{localId:'listener-test',providerUserInfo:[],createdAt:String(Date.now()),lastLoginAt:String(Date.now())}]});
  if(String(url).includes('/documents:commit')){
   savedName=body.writes[0].update.name;
   if(handleCommit)return handleCommit({body,response,name:savedName});
   return response({commitTime:timestamp,writeResults:[{updateTime:timestamp,transformResults:[{timestampValue:timestamp}]}]});
  }
  if(String(url).includes('/documents:batchGet'))return response([{found:{name:savedName,fields:{clientReportId:{stringValue:savedName.split('_').at(-1)}},createTime:timestamp,updateTime:timestamp},readTime:timestamp}]);
  throw new Error('Unexpected SDK request: '+url);
 };
 w.eval(fs.readFileSync(path.join(__dirname,'../vendor/firebase-client.js'),'utf8'));
 return {dom,w,calls,store:{submit:d=>w.RBReportStore.submit(w.JSON.parse(JSON.stringify(d)))}};
}
test('bundled SDK stays idle until submission and writes anonymous identity plus server timestamp',async t=>{
 const h=harness();t.after(()=>h.dom.window.close());assert.equal(h.calls.length,0);const d=draft(),result=await h.store.submit(d);
 assert.equal(result.id,`listener-test_${d.clientReportId}`);const signup=h.calls.filter(c=>c.url.includes('accounts:signUp'));assert.equal(signup.length,1);assert.equal(signup[0].body.returnSecureToken,true);
 const write=h.calls.find(c=>c.url.includes('/documents:commit')).body.writes[0];assert.equal(write.update.fields.reporterUid.stringValue,'listener-test');assert.equal(write.update.fields.selectedWords.mapValue.fields['2'].stringValue,'Gud.');
 assert.equal(write.updateTransforms[0].fieldPath,'createdAt');assert.equal(write.updateTransforms[0].setToServerValue,'REQUEST_TIME');
 await h.store.submit(d);assert.equal(h.calls.filter(c=>c.url.includes('/documents:commit')).length,1);assert.equal(h.calls.filter(c=>c.url.includes('accounts:signUp')).length,1);h.dom.window.close();
});
test('bundled SDK awaits the commit acknowledgement before returning success',async t=>{
 let acknowledge;const h=harness(({response})=>new Promise(resolve=>acknowledge=()=>resolve(response({commitTime:timestamp,writeResults:[{updateTime:timestamp,transformResults:[{timestampValue:timestamp}]}]}))));
 t.after(()=>h.dom.window.close());let complete=false;const pending=h.store.submit(draft()).then(()=>complete=true);
 for(let i=0;i<100&&!acknowledge;i++)await new Promise(r=>setTimeout(r,5));assert.equal(typeof acknowledge,'function');assert.equal(complete,false);acknowledge();await pending;assert.equal(complete,true);h.dom.window.close();
});
test('a lost write response is recovered through the submitting listener’s exact receipt',async t=>{
 const h=harness(({response})=>response({error:{status:'UNAVAILABLE',message:'Response lost'}},503));t.after(()=>h.dom.window.close());const d=draft();assert.equal((await h.store.submit(d)).id,`listener-test_${d.clientReportId}`);
 assert.equal(h.calls.filter(c=>c.url.includes('/documents:batchGet')).length,1);h.dom.window.close();
});
