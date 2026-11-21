'use strict';
const cache=new Map();
async function searchStudioWeb({query,ownerKey,apiKey,fetchImpl=fetch}){
 const normalized=Array.from(String(query||'').replace(/\s+/g,' ').trim()).slice(0,128).join('');
 if(!normalized)throw new Error('Describe the topic you want to search.');
 if(!apiKey)throw new Error('Web search needs the DeepSeek API key.');
 const key=String(ownerKey)+':'+normalized.toLowerCase(),previous=cache.get(key);
 if(previous&&Date.now()-previous.time<120000)return {...previous.value,cached:true};
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
 let response;try{response=await fetchImpl('https://api.deepseek.com/v1/tools/search',{method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},body:JSON.stringify({query:normalized,count:5,need_content:false}),signal:controller.signal});}catch(error){throw new Error(error.name==='AbortError'?'Web search took too long. Please try again.':'Web search is unavailable right now. Try again or turn Search web off.');}finally{clearTimeout(timer);}
 if(!response.ok)throw new Error('Web search is unavailable right now. Try again or turn Search web off.');
 const data=await response.json();const sources=(Array.isArray(data.results)?data.results:[]).slice(0,5).filter(x=>{try{return ['https:','http:'].includes(new URL(x.url).protocol);}catch(_){return false;}}).map(x=>({title:String(x.title||x.url).slice(0,180),url:String(x.url).slice(0,2000),summary:String(x.summary||x.snippet||'').slice(0,1200)}));
 const value={query:normalized,sources,costUsd:sources.length?0.00075:0,cached:false};
 if(cache.size>=128)cache.delete(cache.keys().next().value);cache.set(key,{time:Date.now(),value});return value;
}
module.exports={searchStudioWeb};
