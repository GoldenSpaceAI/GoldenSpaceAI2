(function(){
 'use strict';
 var panel,usage,loading=false;
 function ar(){return document.documentElement.lang==='ar';}
 function label(en,arabic){return ar()?arabic:en;}
 function draw(){
  if(!panel)return;panel.replaceChildren();
  var heading=document.createElement('h3');heading.textContent=label('Feature activity','استخدام الأدوات');panel.appendChild(heading);
  var note=document.createElement('p');note.textContent=label('Daily activity · midnight UTC reset. AI model allowance stays shared.','النشاط اليومي · يتجدد عند منتصف الليل بالتوقيت العالمي. يبقى رصيد نماذج الذكاء الاصطناعي مشتركًا.');panel.appendChild(note);
  if(!usage){var status=document.createElement('p');status.textContent=label('Usage is currently unavailable.','بيانات الاستخدام غير متاحة حاليًا.');panel.appendChild(status);return;}
  [[label('AI images','الصور بالذكاء الاصطناعي'),usage.images.today,usage.images.limit],[label('Document AI requests','طلبات الذكاء الاصطناعي للمستندات'),usage.documents.today,null],[label('Code AI requests','طلبات الذكاء الاصطناعي للبرمجة'),usage.code.today,null],[label('Pexels searches','عمليات البحث في بيكسلز'),usage.pexels.searches,usage.pexels.searchLimit]].forEach(function(row){var item=document.createElement('div');item.className='feature-usage-row';var title=document.createElement('span');title.textContent=row[0];var value=document.createElement('strong');var fmt=new Intl.NumberFormat(ar()?'ar':'en');value.textContent=row[1]==null?'—':fmt.format(row[1])+(row[2]!=null?' / '+fmt.format(row[2]):'');item.append(title,value);panel.appendChild(item);});
  var exports=document.createElement('p');exports.textContent=label('Word / PowerPoint exports in the last 3 days: ','ملفات وورد وباوربوينت المصدّرة خلال آخر ٣ أيام: ')+usage.documents.exportsUsed+(usage.documents.unlimitedExports?' · '+label('Unlimited','دون حد'):' / '+usage.documents.exportLimit);panel.appendChild(exports);
 }
 async function refresh(){
  if(loading)return;loading=true;
  try{var id;try{id=localStorage.getItem('goldenspaceai2_client_id');}catch(_){}var res=await fetch('/api/feature-usage',{credentials:'same-origin',cache:'no-store',headers:id?{'X-Client-Id':id}:{}});if(!res.ok)throw Error();var data=await res.json();usage=data.usage;}catch(_){usage=null;}finally{loading=false;draw();}
 }
 function start(){
  var host=document.querySelector('#content')||document.querySelector('.studio-home-shell')||document.querySelector('.account-card');if(!host)return;
  panel=document.createElement('section');panel.className='feature-usage-card';panel.setAttribute('aria-live','polite');host.appendChild(panel);
  var style=document.createElement('style');style.textContent='.feature-usage-card{margin:18px 0;padding:18px;border:1px solid var(--border,var(--line,#333));border-radius:14px;background:var(--panel,#171b24);color:var(--text,#eee);font-size:12px;text-align:start}.feature-usage-card h3{font-size:15px;margin:0 0 8px}.feature-usage-card p{color:var(--muted,#aaa);line-height:1.6;font-size:11px}.feature-usage-row{display:flex;justify-content:space-between;gap:14px;padding:9px 0;border-bottom:1px solid var(--border,var(--line,#333))}.feature-usage-row strong{white-space:nowrap}.account-card .feature-usage-card{padding:10px;margin-bottom:0}';document.head.appendChild(style);
  refresh();new MutationObserver(draw).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')refresh();});window.refreshFeatureUsage=refresh;
 }
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();
