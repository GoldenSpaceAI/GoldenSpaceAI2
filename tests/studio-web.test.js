const test=require('node:test'),assert=require('node:assert/strict');const {searchStudioWeb}=require('../studioWeb');
test('search uses bounded queries, safe sources, a single low fixed cost, and owner-scoped cache',async()=>{
 let calls=0;
 const fetchImpl=async(url,options)=>{calls++;assert.equal(url,'https://api.deepseek.com/v1/tools/search');const body=JSON.parse(options.body);assert.ok(Array.from(body.query).length<=128);assert.equal(body.count,5);return {ok:true,json:async()=>({results:[{title:'Source',url:'https://example.com',summary:'Evidence'},{title:'Unsafe',url:'javascript:alert(1)'}]})};};
 const args={query:'test topic',ownerKey:'test-owner',apiKey:'test-key',fetchImpl};const first=await searchStudioWeb(args);assert.equal(first.costUsd,.00075);assert.equal(first.sources.length,1);
 const second=await searchStudioWeb(args);assert.equal(second.cached,true);assert.equal(calls,1);await searchStudioWeb({...args,ownerKey:'different'});assert.equal(calls,2);
});
test('unavailable search fails clearly and empty search has no charge',async()=>{
 await assert.rejects(searchStudioWeb({query:'topic',ownerKey:'x'}),/API key/);
 await assert.rejects(searchStudioWeb({query:'failed',ownerKey:'x',apiKey:'test',fetchImpl:async()=>({ok:false})}),/unavailable/);
 const empty=await searchStudioWeb({query:'empty',ownerKey:'x',apiKey:'test',fetchImpl:async()=>({ok:true,json:async()=>({results:[]})})});assert.equal(empty.costUsd,0);
});
