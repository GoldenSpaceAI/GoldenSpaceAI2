(function(){
'use strict';
const ar=()=>document.documentElement.lang==='ar',t=(en,a)=>ar()?a:en,esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let dialog=null,artifact=null,draftHtml='',current=null,library=[],busy=false,mode='game',returnFocus=null;
const errors={
 login_required:['Sign in to publish your game.','سجّل الدخول لنشر لعبتك.'],
 invalid_html:['Open a complete game or HTML project first.','افتح لعبة أو مشروع ويب كاملًا أولًا.'],
 too_large:['This game exceeds the 1 MB publishing limit.','حجم اللعبة يتجاوز حد النشر البالغ ١ ميغابايت.'],
 publication_limit:['Unpublish a game before adding another. You can publish 20 games.','ألغِ نشر لعبة قبل إضافة أخرى. يمكنك نشر ٢٠ لعبة.'],
 saved_limit:['Your library is full. Update an existing game link.','مكتبتك ممتلئة. حدّث أحد روابط ألعابك الحالية.'],
 rate_limit:['Please wait a minute before trying again.','انتظر دقيقة قبل المحاولة مجددًا.'],
 not_found:['This publication is unavailable or belongs to another account.','هذا المنشور غير متاح أو يخص حسابًا آخر.'],
 invalid_origin:['Please open Studio and try again.','افتح الاستوديو وحاول مجددًا.']
};
function message(error){const pair=errors[error.code];return pair?t(...pair):t('Could not complete that action. Please try again.','تعذّر إكمال العملية. حاول مجددًا.');}
async function request(path,options={}){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
 try{const res=await fetch(path,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})},credentials:'same-origin',signal:controller.signal});const data=await res.json().catch(()=>({}));if(!res.ok)throw Object.assign(new Error(data.error||'Request failed'),{code:data.code});return data;}finally{clearTimeout(timer);}
}
function url(pub){return new URL(pub.path||'/play/'+pub.id,location.origin).href;}
function save(pub){
 if(artifact){artifact.publication=pub;window.studioPublicationContext?.save(artifact);}
 refresh(window.studioPublicationContext?.get());current=pub;
}
function close(){if(busy)return;dialog?.close();returnFocus?.focus();}
function shell(){
 if(dialog)return;
 dialog=document.createElement('dialog');dialog.className='publication-dialog';dialog.id='publicationDialog';dialog.setAttribute('aria-labelledby','publicationTitle');document.body.appendChild(dialog);
 dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
}
function status(text,error=false){const el=dialog.querySelector('[data-status]');if(el){el.textContent=text;el.classList.toggle('error',error);}}
function locked(on){busy=on;dialog.querySelectorAll('button').forEach(b=>b.disabled=on);dialog.querySelector('[data-title]')?.toggleAttribute('disabled',on);}
function login(){
 const next=location.pathname+location.search;
 dialog.innerHTML='<div class="publication-head"><h2 id="publicationTitle">'+t('Publish your game','انشر لعبتك')+'</h2><button data-close aria-label="'+t('Close','إغلاق')+'">×</button></div><p>'+t('Sign in to save public links and manage your published games. Anyone with a game link can play without signing in.','سجّل الدخول لحفظ الروابط العامة وإدارة ألعابك المنشورة. يستطيع أي شخص لديه رابط اللعبة اللعب دون تسجيل الدخول.')+'</p><a class="publication-primary" href="/login?next='+encodeURIComponent(next)+'">'+t('Sign in','تسجيل الدخول')+'</a>';
 dialog.querySelector('[data-close]').onclick=close;
}
function titleFor(a){
 if(a.publication?.title)return a.publication.title;
 const match=String(a.data||'').match(/<title[^>]*>([^<]{1,110})<\/title>/i);
 return (match?.[1]||a.title||t('My game','لعبتي')).replace(/\s+/g,' ').trim().slice(0,110);
}
function gameForm(){
 const live=current?.active;
 dialog.innerHTML='<div class="publication-head"><div><span class="publication-kicker">'+t('STUDIO PUBLISHING','النشر من الاستوديو')+'</span><h2 id="publicationTitle">'+(live?t('Your game is public','لعبتك منشورة'):t('Share your game with the world','شارك لعبتك مع الآخرين'))+'</h2></div><button data-close aria-label="'+t('Close','إغلاق')+'">×</button></div><p>'+(live?t('Private edits stay private until you update the live version. Your link stays the same.','تبقى تعديلاتك خاصة حتى تحدّث النسخة المنشورة. يبقى الرابط كما هو.'):t('Publish a separate copy of this game. Anyone with its link can open it without an account.','انشر نسخة مستقلة من هذه اللعبة. يستطيع أي شخص لديه رابطها فتحها دون حساب.'))+'</p><label class="publication-label">'+t('Game title','عنوان اللعبة')+'<input data-title maxlength="110" value="'+esc(current?.title||titleFor(artifact))+'"></label>'+(live?'<div class="publication-link"><input aria-label="'+t('Public game link','رابط اللعبة العام')+'" value="'+esc(url(current))+'" readonly><button data-copy>'+t('Copy link','نسخ الرابط')+'</button><a href="'+esc(url(current))+'" target="_blank" rel="noopener">'+t('Open game ↗','فتح اللعبة ↗')+'</a></div>':'')+'<div data-status role="status" aria-live="polite"></div><div class="publication-actions"><button class="publication-primary" data-publish>'+(live?t('Update live version','تحديث النسخة المنشورة'):t('Publish game','نشر اللعبة'))+'</button>'+(live?'<button data-unpublish>'+t('Unpublish','إلغاء النشر')+'</button>':'')+'<button data-library>'+t('Your published games','ألعابك المنشورة')+'</button></div><div class="publication-note">'+t('Only this game’s code is published. Your chat and project instructions stay private.','يُنشر كود هذه اللعبة فقط. تبقى محادثتك وتعليمات المشروع خاصة.')+'</div>';
 dialog.querySelector('[data-close]').onclick=close;dialog.querySelector('[data-library]').onclick=()=>showLibrary();
 dialog.querySelector('[data-publish]').onclick=publish;
 if(live){dialog.querySelector('[data-copy]').onclick=event=>copy(current,event.currentTarget);dialog.querySelector('[data-unpublish]').onclick=()=>confirmUnpublish(current,()=>gameForm());}
}
async function publish(){
 if(busy)return;const title=dialog.querySelector('[data-title]').value.trim();if(!title){status(t('Give your game a title.','أدخل عنوانًا للعبة.'),true);return;}
 locked(true);status(t('Publishing your game…','جارٍ نشر لعبتك…'));
 try{
 const data=await request('/api/studio/publications'+(current?'/'+current.id:''),{method:current?'PUT':'POST',body:JSON.stringify({title,html:draftHtml})});
 save(data.publication);busy=false;gameForm();status(t('Published. Your game is ready to share.','تم النشر. لعبتك جاهزة للمشاركة.'));
 }catch(error){locked(false);status(message(error),true);}
}
async function copy(pub,button){
 try{await navigator.clipboard.writeText(url(pub));if(button){button.textContent=t('Copied','تم النسخ');setTimeout(()=>{if(button.isConnected)button.textContent=t('Copy link','نسخ الرابط');},1500);}}catch(_){status(t('Select and copy the link above.','حدّد الرابط أعلاه وانسخه.'));}
}
function confirmUnpublish(pub,done){
 const original=dialog.querySelector('.publication-confirm');original?.remove();
 const area=document.createElement('div');area.className='publication-confirm';area.innerHTML='<p>'+t('This link will stop working immediately. Your private Studio code will stay available.','سيتوقف هذا الرابط عن العمل فورًا. سيبقى الكود الخاص بك متاحًا في الاستوديو.')+'</p><button class="publication-danger" data-confirm>'+t('Confirm unpublish','تأكيد إلغاء النشر')+'</button><button data-cancel>'+t('Cancel','إلغاء')+'</button>';dialog.appendChild(area);area.querySelector('[data-cancel]').onclick=()=>area.remove();area.querySelector('[data-confirm]').onclick=async()=>{
 locked(true);
 try{const data=await request('/api/studio/publications/'+pub.id,{method:'DELETE'});if(artifact?.publication?.id===pub.id)save(data.publication);else window.studioPublicationContext?.changed(data.publication);library=library.map(p=>p.id===pub.id?data.publication:p);busy=false;done();status(t('Unpublished. The public link is now closed.','أُلغي النشر. أُغلق الرابط العام الآن.'));}
 catch(error){locked(false);status(message(error),true);}
 };
}
async function showLibrary(){
 mode='library';dialog.innerHTML='<div class="publication-head"><h2 id="publicationTitle">'+t('Your published games','ألعابك المنشورة')+'</h2><button data-close aria-label="'+t('Close','إغلاق')+'">×</button></div><p>'+t('Manage the game links saved to your account.','أدر روابط الألعاب المحفوظة في حسابك.')+'</p><div data-status role="status">'+t('Loading…','جارٍ التحميل…')+'</div><div class="publication-list"></div>';
 dialog.querySelector('[data-close]').onclick=close;
 try{const data=await request('/api/studio/publications');library=data.publications||[];status(library.length?'':t('No published games yet. Create a game in Studio and choose Publish.','لا توجد ألعاب منشورة بعد. أنشئ لعبة في الاستوديو ثم اختر نشر.'));
 const list=dialog.querySelector('.publication-list');
 library.forEach(pub=>{const row=document.createElement('section');row.className='publication-row';row.innerHTML='<div><strong>'+esc(pub.title)+'</strong><span>'+(pub.active?t('Public','منشورة'):t('Unpublished','غير منشورة'))+' · '+t('Version ','النسخة ')+pub.revision+'</span></div>'+(pub.active?'<nav><a target="_blank" rel="noopener" href="'+esc(url(pub))+'">'+t('Open ↗','فتح ↗')+'</a><button data-copy>'+t('Copy link','نسخ الرابط')+'</button><button data-remove>'+t('Unpublish','إلغاء النشر')+'</button></nav>':'');
 if(pub.active){row.querySelector('[data-copy]').onclick=e=>copy(pub,e.currentTarget);row.querySelector('[data-remove]').onclick=()=>confirmUnpublish(pub,()=>showLibrary());}list.appendChild(row);});
 }catch(error){if(error.code==='login_required')login();else status(message(error),true);}
}
async function open(a){
 if(!a||a.kind!=='code')return;
 shell();artifact=a;draftHtml=String(a.data||'');current=null;mode='game';returnFocus=document.activeElement;
 dialog.dir=ar()?'rtl':'ltr';if(!dialog.open)dialog.showModal();dialog.innerHTML='<p role="status">'+t('Checking your publishing account…','جارٍ التحقق من حساب النشر…')+'</p>';
 try{const data=await request('/api/studio/publications');library=data.publications||[];current=library.find(p=>p.id===a.publication?.id)||null;gameForm();}
 catch(error){if(error.code==='login_required')login();else{gameForm();status(message(error),true);dialog.querySelector('[data-publish]').disabled=true;}}
}
function refresh(a){
 const button=document.getElementById('publishGame');if(!button)return;button.hidden=!a||a.kind!=='code';button.textContent=a?.publication?.active?t('Share game','مشاركة اللعبة'):t('Publish game','نشر اللعبة');
}
function mount(){
 const actions=document.querySelector('.preview-actions');if(!actions)return;
 const button=document.createElement('button');button.type='button';button.id='publishGame';button.className='publish-game-button';button.onclick=()=>open(window.studioPublicationContext?.get());actions.prepend(button);refresh(window.studioPublicationContext?.get());
 const target=document.querySelector('.studio-home-actions')||document.querySelector('.side-nav');
 if(target){const libraryButton=document.createElement('button');libraryButton.type='button';libraryButton.className='published-library-button';libraryButton.textContent=t('Published games','الألعاب المنشورة');libraryButton.onclick=()=>{shell();artifact=null;returnFocus=libraryButton;dialog.dir=ar()?'rtl':'ltr';dialog.showModal();showLibrary();};target.appendChild(libraryButton);}
 new MutationObserver(()=>{refresh(window.studioPublicationContext?.get());document.querySelectorAll('.published-library-button').forEach(b=>b.textContent=t('Published games','الألعاب المنشورة'));}).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
}
window.StudioPublishing={open,refresh};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount);else mount();
})();