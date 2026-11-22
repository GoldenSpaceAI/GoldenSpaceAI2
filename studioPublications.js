'use strict';
const crypto=require('crypto');
const MAX_HTML_BYTES=1024*1024, MAX_ACTIVE=20, MAX_SAVED=100;
const validId=id=>/^[a-f0-9]{32}$/.test(String(id||''));
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function problem(status,code,message){return Object.assign(new Error(message),{status,code});}
function validate(input){
 const title=String(input?.title||'My game').replace(/\s+/g,' ').trim().slice(0,110)||'My game',html=input?.html;
 if(typeof html!=='string'||html.length<30||!/<(?:!doctype\s+html|html)[\s>]/i.test(html))throw problem(400,'invalid_html','Open a complete game or HTML project before publishing.');
 if(Buffer.byteLength(html,'utf8')>MAX_HTML_BYTES)throw problem(413,'too_large','This game is too large to publish. The limit is 1 MB.');
 return {title,html};
}
function metadata(row){return {id:row.id,title:row.title,active:row.active,revision:row.revision,createdAt:row.created_at,updatedAt:row.updated_at,path:'/play/'+row.id};}
function createPublicationsStore(getPool){
 let schema=null;
 async function ready(){
  const pool=getPool();if(!pool)throw problem(503,'storage_unavailable','Publishing storage is temporarily unavailable.');
  if(!schema)schema=pool.query(`CREATE TABLE IF NOT EXISTS studio_publications (
   id TEXT PRIMARY KEY CHECK (id ~ '^[a-f0-9]{32}$'),
   owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
   title TEXT NOT NULL, html TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE,
   revision INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  ); CREATE INDEX IF NOT EXISTS studio_publications_owner_idx ON studio_publications(owner_id,active,updated_at DESC)`).catch(error=>{schema=null;throw error;});
  await schema;return pool;
 }
 async function list(owner){
  const pool=await ready();const rows=await pool.query('SELECT id,title,active,revision,created_at,updated_at FROM studio_publications WHERE owner_id=$1 ORDER BY active DESC,updated_at DESC LIMIT 100',[owner]);return rows.rows.map(metadata);
 }
 async function save(owner,input,id){
  const data=validate(input);if(id&&!validId(id))throw problem(404,'not_found','Published game not found.');
  const pool=await ready(),client=await pool.connect();
  try{
   await client.query('BEGIN');const lock=crypto.createHash('sha256').update(String(owner)).digest().readInt32BE(0);await client.query('SELECT pg_advisory_xact_lock($1::integer)',[lock]);
   let existing=null;if(id){const row=await client.query('SELECT id,active FROM studio_publications WHERE id=$1 AND owner_id=$2 FOR UPDATE',[id,owner]);existing=row.rows[0];if(!existing)throw problem(404,'not_found','Published game not found.');}
   const count=await client.query('SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE active=TRUE) AS active FROM studio_publications WHERE owner_id=$1',[owner]);
   if(!existing&&Number(count.rows[0].total)>=MAX_SAVED)throw problem(429,'saved_limit','Your library is full. Update one of your existing game links.');
   if(!existing?.active&&Number(count.rows[0].active)>=MAX_ACTIVE)throw problem(429,'publication_limit','You can have 20 published games. Unpublish one before publishing another.');
   let result;
   if(existing)result=await client.query('UPDATE studio_publications SET title=$3,html=$4,active=TRUE,revision=revision+1,updated_at=NOW() WHERE id=$1 AND owner_id=$2 RETURNING id,title,active,revision,created_at,updated_at',[id,owner,data.title,data.html]);
   else result=await client.query('INSERT INTO studio_publications (id,owner_id,title,html) VALUES ($1,$2,$3,$4) RETURNING id,title,active,revision,created_at,updated_at',[crypto.randomBytes(16).toString('hex'),owner,data.title,data.html]);
   await client.query('COMMIT');return metadata(result.rows[0]);
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
 }
 async function unpublish(owner,id){
  if(!validId(id))throw problem(404,'not_found','Published game not found.');const pool=await ready();
  const result=await pool.query("UPDATE studio_publications SET active=FALSE,html='',updated_at=NOW() WHERE id=$1 AND owner_id=$2 RETURNING id,title,active,revision,created_at,updated_at",[id,owner]);
  if(!result.rows.length)throw problem(404,'not_found','Published game not found.');return metadata(result.rows[0]);
 }
 async function read(id,includeHtml=false){
  if(!validId(id))return null;const pool=await ready(),result=await pool.query('SELECT id,title,revision,updated_at'+(includeHtml?',html':'')+' FROM studio_publications WHERE id=$1 AND active=TRUE',[id]);return result.rows[0]||null;
 }
 return {ready,list,save,unpublish,read};
}
function wrapper(row){
 const nonce=crypto.randomBytes(18).toString('base64'),title=escape(row.title),src='/play/'+row.id+'/content?v='+Number(row.revision);
 const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="dark"><title>${title} · GoldenoAI</title><meta property="og:type" content="website"><meta property="og:title" content="${title} · GoldenoAI"><meta property="og:description" content="Play ${title}, a game built with GoldenoAI Studio. Build your own game in Studio."><meta property="og:url" content="https://goldenoai.com/play/${row.id}"><meta name="twitter:card" content="summary"><style nonce="${nonce}">*{box-sizing:border-box}html,body{height:100%;margin:0}body{background:#0b0e14;color:#f7f5ee;font:14px/1.5 system-ui,-apple-system,sans-serif;display:flex;flex-direction:column}header{min-height:66px;display:flex;align-items:center;justify-content:space-between;gap:18px;padding:12px 22px;border-bottom:1px solid #ffffff16;background:#11151d}.identity{min-width:0}.identity strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:65vw;font-size:15px}.identity a{font-size:11px;color:#c5a653;text-decoration:none}nav{display:flex;gap:8px}button{font:inherit;cursor:pointer;color:inherit;border:1px solid #ffffff24;background:#1c222d;padding:8px 12px;border-radius:10px}button:hover{border-color:#d4af37}main{flex:1;min-height:0}iframe{width:100%;height:100%;display:block;border:0;background:#090c12}footer{display:flex;align-items:center;justify-content:space-between;gap:14px;color:#f7f5ee;padding:12px 22px;border-top:1px solid #ffffff16;background:#11151d}footer strong{display:block;font-size:13px}footer small{display:block;font-size:10px;color:#939ba8;margin-top:2px}.build-cta{flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;min-height:42px;text-decoration:none;color:#211806;background:#e0bd50;font-size:13px;font-weight:750;border-radius:10px;padding:10px 16px}.build-cta:hover{background:#f1ce60}@media(max-width:600px){header{padding:10px 12px;gap:8px}.identity strong{max-width:49vw}button{font-size:12px;padding:8px}footer{padding:10px 12px;gap:8px}footer strong{font-size:11px}footer small{font-size:9px}.build-cta{font-size:11px;padding:9px 11px}}</style></head><body><header><div class="identity"><strong>${title}</strong><a href="/studio" target="_blank" rel="noopener" id="made">Made with GoldenoAI Studio</a></div><nav><button id="restart">Restart</button><button id="fullscreen">Full screen</button></nav></header><main id="stage"><iframe id="game" title="${title}" sandbox="allow-scripts" allow="autoplay; fullscreen" allowfullscreen referrerpolicy="no-referrer" src="${src}"></iframe></main><footer><div><strong id="builtBy">This game was built with GoldenoAI</strong><small id="caption">Turn your next idea into a game in Studio.</small></div><a class="build-cta" id="buildYours" href="/studio/chat?create=game" target="_blank" rel="noopener">Build yours now ↗</a></footer><script nonce="${nonce}">(()=>{const game=document.getElementById('game'),stage=document.getElementById('stage');document.getElementById('restart').onclick=()=>{game.src=game.getAttribute('src')};document.getElementById('fullscreen').onclick=()=>{if(stage.requestFullscreen)stage.requestFullscreen().catch(()=>{});else if(stage.webkitRequestFullscreen)stage.webkitRequestFullscreen()};try{if(localStorage.getItem('goldenspaceai_language')==='ar'){document.documentElement.lang='ar';document.documentElement.dir='rtl';document.getElementById('made').textContent='أُنشئت باستخدام استوديو جولدن سبيس';document.getElementById('restart').textContent='إعادة التشغيل';document.getElementById('fullscreen').textContent='ملء الشاشة';document.getElementById('caption').textContent='حوّل فكرتك التالية إلى لعبة في الاستوديو.';document.getElementById('builtBy').textContent='صُمّمت هذه اللعبة باستخدام جولدن سبيس';document.getElementById('buildYours').textContent='أنشئ لعبتك الآن ↗'}}catch(_){}})();</script></body></html>`;
 return {html,nonce};
}
function headers(res){res.setHeader('Cache-Control','no-store, max-age=0');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Robots-Tag','noindex, nofollow');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=(), payment=(), usb=()');}
function mountPublications(app,{getPool,getUser}){
 const store=createPublicationsStore(getPool),rate=new Map();
 function owner(req,res,write=false){
  res.setHeader('Cache-Control','private, no-store');
  const user=getUser(req);if(!user?.id){res.status(401).json({error:'Sign in to publish and manage game links.',code:'login_required',loginUrl:'/login?next=%2Fstudio%2Fchat'});return null;}
  const origin=req.get('origin');if(origin){let host;try{host=new URL(origin).host;}catch(_){res.status(403).json({error:'This request must come from Studio.',code:'invalid_origin'});return null;}if(host!==req.get('host')){res.status(403).json({error:'This request must come from Studio.',code:'invalid_origin'});return null;}}
  if(write){
   const now=Date.now(),key=String(user.id),bucket=rate.get(key);if(bucket&&now-bucket.time<60000&&bucket.count>=20){res.status(429).json({error:'Please wait a minute before publishing again.',code:'rate_limit'});return null;}if(!bucket||now-bucket.time>=60000){if(rate.size>=5000)rate.delete(rate.keys().next().value);rate.set(key,{time:now,count:1});}else bucket.count++;
  }
  return user.id;
 }
 function fail(res,error){if(!error.status)console.error('studio publishing:',error.message);res.status(error.status||503).json({error:error.status?error.message:'Publishing is temporarily unavailable. Please try again.',code:error.code||'publishing_unavailable'});}
 app.get('/api/studio/publications',async(req,res)=>{const id=owner(req,res);if(!id)return;try{res.setHeader('Cache-Control','private, no-store');res.json({publications:await store.list(id),maxActive:MAX_ACTIVE});}catch(e){fail(res,e);}});
 app.post('/api/studio/publications',async(req,res)=>{const id=owner(req,res,true);if(!id)return;try{res.status(201).json({publication:await store.save(id,req.body)});}catch(e){fail(res,e);}});
 app.put('/api/studio/publications/:id',async(req,res)=>{const id=owner(req,res,true);if(!id)return;try{res.json({publication:await store.save(id,req.body,req.params.id)});}catch(e){fail(res,e);}});
 app.delete('/api/studio/publications/:id',async(req,res)=>{const id=owner(req,res,true);if(!id)return;try{res.json({publication:await store.unpublish(id,req.params.id)});}catch(e){fail(res,e);}});
 app.get('/play/:id',async(req,res)=>{
  headers(res);try{const row=await store.read(req.params.id);if(!row)return res.status(404).type('html').send('<!doctype html><meta name="viewport" content="width=device-width"><title>Game unavailable</title><h1>This game is not published</h1><p>The creator may have unpublished it.</p><a href="/studio">Open Studio</a>');
   const page=wrapper(row);res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'nonce-"+page.nonce+"'; script-src 'nonce-"+page.nonce+"'; frame-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'");res.type('html').send(page.html);
  }catch(e){res.status(503).type('html').send('<!doctype html><title>Game temporarily unavailable</title><h1>Please try again shortly</h1>');}
 });
 app.get('/play/:id/content',async(req,res)=>{
  headers(res);res.setHeader('Content-Security-Policy',"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src https: data: blob:; media-src https: data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
  try{const row=await store.read(req.params.id,true);if(!row)return res.status(404).type('html').send('<!doctype html><title>Game unavailable</title><p>This game is no longer published.</p>');res.type('html').send(row.html);}catch(e){res.status(503).type('html').send('<!doctype html><title>Game unavailable</title><p>Please try again shortly.</p>');}
 });
 return store;
}
module.exports={createPublicationsStore,mountPublications,validate,wrapper,MAX_HTML_BYTES};
