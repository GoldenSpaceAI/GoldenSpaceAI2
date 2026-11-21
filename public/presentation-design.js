(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.PresentationDesign=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 function chooseTheme(topic){
  var t=String(topic||'').toLowerCase();
  var rules=[['heritage',/history|ottoman|empire|ancient|archaeolog|تاريخ|عثمان|إمبراط|حضار/],['science',/science|physics|space|astronom|chemistry|علم|فيزياء|فضاء|كيمياء/],['forest',/nature|climate|environment|ecolog|sustainab|بيئة|طبيعة|مناخ/],['corporate',/business|finance|company|market|strategy|investment|أعمال|شركة|استثمار|تسويق/],['creative',/art|design|fashion|music|creative|فن|تصميم|موسيقى/],['ocean',/health|medicine|ocean|water|صحة|طب|بحر|ماء/],['classroom',/lesson|school|education|تعليم|مدرسة|درس/]];
  for(var r of rules)if(r[1].test(t))return r[0];return 'editorial';
 }
 function highlights(slide){
  var list=[];
  if(slide.titleHighlight)list.push({text:slide.titleHighlight,tone:'accent'});
  if(Array.isArray(slide.highlights))list=list.concat(slide.highlights);
  var seen=new Set();
  return list.slice(0,20).map(function(x){return {text:String(typeof x==='string'?x:x&&x.text||'').trim().slice(0,70),tone:x&&x.tone==='secondary'?'secondary':'accent'};}).filter(function(x){if(x.text.length<2||seen.has(x.text))return false;seen.add(x.text);return true;}).slice(0,8);
 }
 function runs(text,marks){
  text=String(text||'');var sorted=(marks||[]).filter(x=>x.text).slice().sort((a,b)=>b.text.length-a.text.length),out=[],plain='';
  for(var i=0;i<text.length;){var found=sorted.find(x=>text.startsWith(x.text,i));if(found){if(plain){out.push({text:plain});plain='';}out.push({text:found.text,tone:found.tone});i+=found.text.length;}else{plain+=text[i++];}}
  if(plain)out.push({text:plain});return out.length?out:[{text:''}];
 }
 function layout(slide,index,total){
  if(total>1&&index===0)return 'cover';if(total>2&&index===total-1)return 'closing';
  if(slide.layout==='quote'&&slide.quote)return 'quote';if(slide.layout==='stat'&&slide.stat)return 'stat';
  if(slide.layout==='compare'&&(slide.leftBullets||[]).length&&(slide.rightBullets||[]).length)return 'compare';
  if(['timeline','process'].includes(slide.layout)&&(slide.bullets||[]).length)return slide.layout;
  return 'content';
 }
 return {chooseTheme:chooseTheme,highlights:highlights,runs:runs,layout:layout};
});
