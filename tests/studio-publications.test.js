const test=require('node:test'),assert=require('node:assert/strict'),{newDb,DataType}=require('pg-mem'),express=require('express');
const {mountPublications,validate,wrapper,MAX_HTML_BYTES}=require('../studioPublications');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
async function setup(){
 const db=newDb();db.public.registerOperator({operator:'~',left:DataType.text,right:DataType.text,returns:DataType.bool,implementation:(a,b)=>new RegExp(b).test(a)});db.public.registerFunction({name:'pg_advisory_xact_lock',args:[DataType.integer],returns:DataType.integer,implementation:()=>1});
 db.public.none('CREATE TABLE users(id UUID PRIMARY KEY)');db.public.none("INSERT INTO users VALUES ('"+A+"'),('"+B+"')");
 const {Pool}=db.adapters.createPg(),pool=new Pool(),app=express();app.use(express.json({limit:'2mb'}));
 const store=mountPublications(app,{getPool:()=>pool,getUser:req=>req.headers['x-test-user']?{id:req.headers['x-test-user']}:null});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base='http://127.0.0.1:'+server.address().port;
 async function api(path,method='GET',user=A,body,headers={}){
 const res=await fetch(base+path,{method,headers:{'content-type':'application/json',...(user?{'x-test-user':user}:{}),...headers},body:body?JSON.stringify(body):undefined});const txt=await res.text();let data;try{data=JSON.parse(txt);}catch(_){data=txt;}return {res,data};
 }
 return {pool,store,api,close:async()=>{await new Promise(resolve=>server.close(resolve));await pool.end();}};
}
const html='<!doctype html><html><body><button onclick="this.textContent=\'Playing\'">Play</button></body></html>';
test('publish snapshots, keep stable links for explicit updates, enforce owners, and revoke public content',async()=>{
 const env=await setup();try{
 const guest=await env.api('/api/studio/publications','POST',null,{title:'Game',html});assert.equal(guest.res.status,401);
 const created=await env.api('/api/studio/publications','POST',A,{title:'Game </title><script>alert(1)</script>',html,ownerId:B});assert.equal(created.res.status,201,JSON.stringify(created.data));const pub=created.data.publication;assert.match(pub.id,/^[a-f0-9]{32}$/);assert.equal(pub.revision,1);
 const listed=await env.api('/api/studio/publications');assert.equal(listed.data.publications.length,1);assert.equal(listed.data.publications[0].html,undefined);
 const page=await env.api(pub.path,'GET',null);assert.equal(page.res.status,200);assert.ok(page.data.includes('sandbox="allow-scripts"'));assert.ok(!page.data.includes('allow-same-origin'));assert.ok(page.data.includes('Build yours now'));assert.ok(page.data.includes('/studio/chat?create=game'));assert.ok(!page.data.includes('<script>alert(1)</script>'));
 const frame=await env.api(pub.path+'/content','GET',null);assert.equal(frame.data,html);assert.match(frame.res.headers.get('content-security-policy'),/sandbox allow-scripts/);assert.match(frame.res.headers.get('content-security-policy'),/connect-src 'none'/);assert.match(frame.res.headers.get('cache-control'),/no-store/);
 const other=await env.api('/api/studio/publications/'+pub.id,'PUT',B,{title:'Stolen',html});assert.equal(other.res.status,404);assert.equal((await env.api('/api/studio/publications/'+pub.id,'DELETE',B)).res.status,404);
 const csrf=await env.api('/api/studio/publications','POST',A,{title:'Bad origin',html},{origin:'https://unrelated.example'});assert.equal(csrf.res.status,403);
 const updated=await env.api('/api/studio/publications/'+pub.id,'PUT',A,{title:'Updated game',html:html.replace('Play','Jump')});assert.equal(updated.data.publication.id,pub.id);assert.equal(updated.data.publication.revision,2);assert.match((await env.api(pub.path+'/content','GET',null)).data,/Jump/);
 assert.equal((await env.api('/api/studio/publications/'+pub.id,'DELETE')).res.status,200);assert.equal((await env.api(pub.path,'GET',null)).res.status,404);assert.equal((await env.api(pub.path+'/content','GET',null)).res.status,404);
 assert.equal((await env.api('/api/studio/publications')).data.publications[0].active,false);
 }finally{await env.close();}
});
test('validate size, reject incomplete code and enforce per-account storage limits',async()=>{
 assert.throws(()=>validate({html:'hello'}),/complete game/);assert.throws(()=>validate({html:'<!doctype html>'+ 'é'.repeat(MAX_HTML_BYTES)}),/1 MB/);
 const env=await setup();try{for(let i=0;i<20;i++)await env.store.save(A,{title:'Game '+i,html});await assert.rejects(env.store.save(A,{title:'Over limit',html}),e=>e.code==='publication_limit');assert.equal((await env.store.list(A)).length,20);assert.equal((await env.store.list(B)).length,0);}finally{await env.close();}
});

