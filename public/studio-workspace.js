(function(){
 'use strict';
 const $=id=>document.getElementById(id), ar=()=>document.documentElement.lang==='ar', t=(en,a)=>ar()?a:en;
 let stages=[],timer=null,started=0,tourIndex=0,previousFocus=null;
 const mic='<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg>';
 function progress(title,detail){
  if(!$('thinking')){const el=document.createElement('article');el.id='thinking';el.className='message studio-progress';el.innerHTML='<details><summary><span class="progress-dot"></span><strong></strong><time></time></summary><ol></ol></details>';$('messages').appendChild(el);started=Date.now();stages=[];clearInterval(timer);timer=setInterval(()=>{const node=$('thinking');if(node)node.querySelector('time').textContent=Math.floor((Date.now()-started)/1000)+'s';},1000);}
  const node=$('thinking');node.querySelector('strong').textContent=title;
  if(!stages.includes(detail)){stages.push(detail);const li=document.createElement('li');li.textContent=detail;node.querySelector('ol').appendChild(li);}
  $('chat').scrollTop=$('chat').scrollHeight;
 }
 function stop(){clearInterval(timer);timer=null;$('thinking')?.remove();stages=[];}
 function setCodeView(mode){const code=$('previewBody')?.querySelector('.code-preview');if(!code)return;code.dataset.view=mode;document.querySelectorAll('[data-code-view]').forEach(b=>{b.setAttribute('aria-pressed',String(b.dataset.codeView===mode));});}
 function mount(){
  if(!$('app')||!$('previewBody'))return;
  document.querySelectorAll('.account-card .feature-usage-card').forEach(x=>x.remove());
  const actions=document.querySelector('.preview-actions');
  const views=document.createElement('div');views.className='code-view-switch';views.hidden=true;views.id='codeViewSwitch';
  [['game','Preview','المعاينة'],['code','Code','الكود']].forEach(([mode,en,a])=>{const b=document.createElement('button');b.type='button';b.dataset.codeView=mode;b.textContent=t(en,a);b.onclick=()=>setCodeView(mode);views.appendChild(b);});actions.prepend(views);
  const expand=document.createElement('button');expand.id='expandPreview';expand.type='button';expand.textContent=t('Expand','توسيع');expand.setAttribute('aria-pressed','false');expand.onclick=()=>{const active=$('app').classList.toggle('preview-expanded');expand.textContent=active?t('Restore','استعادة'):t('Expand','توسيع');expand.setAttribute('aria-pressed',String(active));};actions.appendChild(expand);
  const dock=document.createElement('button');dock.type='button';dock.textContent=t('Switch side','تبديل الجانب');dock.onclick=()=>{$('app').classList.toggle('preview-left');};actions.appendChild(dock);
  const handle=document.createElement('div');handle.className='preview-resize';handle.tabIndex=0;handle.setAttribute('role','separator');handle.setAttribute('aria-label',t('Resize preview','تغيير عرض المعاينة'));handle.setAttribute('aria-orientation','vertical');handle.setAttribute('aria-valuemin','320');handle.setAttribute('aria-valuemax',String(Math.max(320,innerWidth-570)));handle.setAttribute('aria-valuenow',String(Math.round($('preview').getBoundingClientRect().width)||480));
  function resize(width){const max=Math.max(320,innerWidth-570),value=Math.max(320,Math.min(max,width));$('app').style.setProperty('--preview-width',value+'px');handle.setAttribute('aria-valuenow',String(Math.round(value)));}
  handle.onpointerdown=e=>{handle.setPointerCapture(e.pointerId);const initial=$('preview').getBoundingClientRect().width,start=e.clientX;handle.onpointermove=ev=>{const sign=($('app').classList.contains('preview-left')?-1:1)*(ar()?-1:1);resize(initial+(start-ev.clientX)*sign);};handle.onpointerup=()=>{handle.onpointermove=null;};};handle.onkeydown=e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();resize($('preview').getBoundingClientRect().width+(e.key==='ArrowLeft'?40:-40));}};$('preview').prepend(handle);
  const web=document.createElement('button');web.type='button';web.id='studioWebSearch';web.className='studio-web-search';web.textContent=t('Search web','البحث في الويب');web.setAttribute('aria-pressed','false');web.title=t('Use current web sources in your next answer or presentation','استخدام مصادر من الويب في الإجابة أو العرض التقديمي');web.onclick=()=>{window.studioSearchEnabled=!window.studioSearchEnabled;web.setAttribute('aria-pressed',String(window.studioSearchEnabled));};
  const tools=document.createElement('div');tools.className='composer-toolbar';tools.appendChild(web);document.querySelector('.compose-row').before(tools);
  $('micBtn').innerHTML=mic;
  new MutationObserver(()=>{if($('micBtn').textContent==='●')$('micBtn').innerHTML=mic;}).observe($('micBtn'),{childList:true});
  new MutationObserver(()=>{const code=!!$('previewBody').querySelector('.code-preview');views.hidden=!code;if(code)setCodeView('game');}).observe($('previewBody'),{childList:true});
  const help=document.createElement('button');help.type='button';help.className='icon-btn';help.textContent=t('Quick tour','جولة تعريفية');help.onclick=()=>tour(0);document.querySelector('.top-actions').appendChild(help);
  new MutationObserver(()=>{help.textContent=t('Quick tour','جولة تعريفية');web.textContent=t('Search web','البحث في الويب');dock.textContent=t('Switch side','تبديل الجانب');expand.textContent=$('app').classList.contains('preview-expanded')?t('Restore','استعادة'):t('Expand','توسيع');views.querySelector('[data-code-view=game]').textContent=t('Preview','المعاينة');views.querySelector('[data-code-view=code]').textContent=t('Code','الكود');document.querySelectorAll('.studio-sources summary').forEach(node=>node.textContent=t('Sources','المصادر'));if(document.querySelector('.studio-tour'))tour(tourIndex);}).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
  $('closePreview').addEventListener('click',()=>{$('app').classList.remove('preview-expanded');expand.setAttribute('aria-pressed','false');expand.textContent=t('Expand','توسيع');});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){endTour();$('app').classList.remove('preview-expanded');expand.setAttribute('aria-pressed','false');expand.textContent=t('Expand','توسيع');}});
  let seen=false;try{seen=localStorage.getItem('gsa_studio_tour_v2')==='done';}catch(_){}if(!seen&&location.pathname.includes('/chat'))setTimeout(()=>tour(0),500);
 }
 const steps=[['.compose-row','Start with your idea','اكتب فكرتك','Describe what you want to create or ask a question.','صف ما تريد إنشاءه أو اطرح سؤالك.'],['#plusBtn','Choose a creation tool','اختر أداة الإنشاء','Use + for presentations, documents, images, or code. You can also ask naturally.','استخدم زر الإضافة للعروض والمستندات والصور والبرمجة، أو اكتب طلبك مباشرة.'],['#studioWebSearch','Add web research','أضف بحثًا في الويب','Enable Search web before sending a request to use current sources. It also works with presentations.','فعّل البحث قبل إرسال طلبك لاستخدام مصادر حديثة، بما في ذلك في العروض التقديمية.'],['.preview','Preview and refine','عاين وعدّل','Open Preview on a generated file. Expand it, switch its side, or drag its edge. Code has separate Preview and Code views.','افتح معاينة الملف ثم وسّعها أو بدّل جانبها أو اسحب حافتها. للكود عرضان مستقلان: المعاينة والكود.']];
 function endTour(){document.querySelector('.studio-tour')?.remove();document.querySelectorAll('.tour-target').forEach(e=>e.classList.remove('tour-target'));previousFocus?.focus();}
 function tour(index){
  endTour();if(index===0)previousFocus=document.activeElement;tourIndex=index;const step=steps[index];if(!step)return;
  const target=document.querySelector(step[0]);if(target&&target.getClientRects().length){target.classList.add('tour-target');target.scrollIntoView({block:'nearest'});}
  const overlay=document.createElement('div');overlay.className='studio-tour';overlay.innerHTML='<section role="dialog" aria-modal="true" aria-label="'+t('Studio tour','جولة الاستوديو')+'"><span>'+t('STUDIO GUIDE','دليل الاستوديو')+' · '+(index+1)+' / '+steps.length+'</span><h2></h2><p></p><div><button data-tour="close">'+t('Skip','تخطي')+'</button><button data-tour="back" '+(index===0?'disabled':'')+'>'+t('Back','السابق')+'</button><button data-tour="next">'+(index===steps.length-1?t('Done','تم'):t('Next','التالي'))+'</button></div></section>';
  if(target&&target.getClientRects().length){const rect=target.getBoundingClientRect(),spot=document.createElement('div');spot.className='tour-spot';Object.assign(spot.style,{left:(rect.left-5)+'px',top:(rect.top-5)+'px',width:(rect.width+10)+'px',height:(rect.height+10)+'px'});overlay.prepend(spot);overlay.style.background='transparent';overlay.style.alignItems=rect.top>innerHeight/2?'flex-start':'flex-end';}
  overlay.querySelector('h2').textContent=step[ar()?2:1];overlay.querySelector('p').textContent=step[ar()?4:3];document.body.appendChild(overlay);
  const finish=()=>{try{localStorage.setItem('gsa_studio_tour_v2','done');}catch(_){}endTour();};overlay.querySelector('[data-tour=close]').onclick=finish;overlay.querySelector('[data-tour=back]').onclick=()=>tour(index-1);overlay.querySelector('[data-tour=next]').onclick=()=>index===steps.length-1?finish():tour(index+1);overlay.querySelector('[data-tour=next]').focus();
  overlay.onkeydown=e=>{if(e.key==='Tab'){const b=Array.from(overlay.querySelectorAll('button:not(:disabled)'));if(e.shiftKey&&document.activeElement===b[0]){e.preventDefault();b[b.length-1].focus();}else if(!e.shiftKey&&document.activeElement===b[b.length-1]){e.preventDefault();b[0].focus();}}};
 }
 window.StudioUX={progress,stop,setCodeView};
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount);else mount();
})();
