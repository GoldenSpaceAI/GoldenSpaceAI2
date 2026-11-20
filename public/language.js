/* Shared interface language. Conversation content is never translated. */
(function () {
  'use strict';
  var key = 'goldenspaceai_language', lang = 'en';
  try { lang = localStorage.getItem(key) === 'ar' ? 'ar' : 'en'; } catch (_) {}
  var words = {
    'GoldenSpaceAI':'جولدن سبيس','GoldenSpaceAI Studio':'استوديو جولدن سبيس','Studio':'الاستوديو','Chat':'المحادثة','Chats':'المحادثات','Standard chat':'المحادثة العادية','New chat':'محادثة جديدة','New Chat':'محادثة جديدة','New Studio chat':'محادثة جديدة في الاستوديو','Studio chat':'محادثة الاستوديو','All chats':'كل المحادثات','Search chats...':'ابحث في المحادثات…','Search chats…':'ابحث في المحادثات…','Projects':'المشاريع','PROJECTS':'المشاريع','Create project':'إنشاء مشروع','New project':'مشروع جديد','Project name':'اسم المشروع','Instructions':'التعليمات','Project instructions':'تعليمات المشروع','Color':'اللون','Create':'إنشاء','Save':'حفظ','Cancel':'إلغاء','Delete':'حذف','Rename':'إعادة التسمية','Move to project':'نقل إلى مشروع','No chats in this project yet':'لا توجد محادثات في هذا المشروع بعد','WORKSPACE':'مساحة العمل','Workspace':'مساحة العمل','Back to projects':'العودة إلى المشاريع','Open project':'فتح المشروع',
    'How can I help?':'كيف يمكنني مساعدتك؟','Research, code, writing, and analysis — pick a mode, then ask.':'للبحث والبرمجة والكتابة والتحليل، اختر وضعًا وابدأ بسؤالك.','Explain a concept':'اشرح لي مفهومًا','Debug / review code':'راجع الكود وأصلح أخطاءه','Draft professional writing':'ساعدني في كتابة نص احترافي','Plan a project':'ساعدني في تخطيط مشروع','Message':'رسالة','Send':'إرسال','Send message':'إرسال الرسالة','Message GoldenSpaceAI':'اكتب رسالتك لجولدن سبيس','Type a message...':'اكتب رسالتك…','Ask anything':'اسأل عمّا تريد','Attach':'إرفاق','Choose mode':'اختيار وضع المحادثة','Fast':'السريع','Thinking':'التفكير','Expert 4':'فريق من ٤ خبراء','Expert 16':'فريق من ١٦ خبيرًا','Copy':'نسخ','Copied':'تم النسخ','Retry':'إعادة المحاولة','Listen':'استمع','Preview':'معاينة','Download':'تنزيل','Edit':'تعديل','You':'أنت',
    'Settings':'الإعدادات','Account':'الحساب','Account details':'تفاصيل الحساب','Language':'اللغة','Theme':'المظهر','Light':'فاتح','Dark':'داكن','Notifications':'الإشعارات','Usage':'الاستخدام','Usage & plan':'الاستخدام والاشتراك','View usage & plan':'عرض الاستخدام والاشتراك','My Plan':'اشتراكي','My plan':'اشتراكي','Upgrade':'الاشتراكات','Upgrade plan':'ترقية الاشتراك','Log in':'تسجيل الدخول','Login':'تسجيل الدخول','Log out':'تسجيل الخروج','Sign out':'تسجيل الخروج','Continue with Google':'المتابعة باستخدام Google','Email':'البريد الإلكتروني','Email address':'عنوان البريد الإلكتروني','Password':'كلمة المرور','Continue':'متابعة','Back':'رجوع','Close':'إغلاق','Menu':'القائمة','Install App':'تثبيت التطبيق','Install app':'تثبيت التطبيق','Terms':'شروط الاستخدام','Privacy':'سياسة الخصوصية','Refund':'سياسة الاسترداد','Need help':'تحتاج إلى مساعدة؟',
    'Free':'المجاني','FREE':'المجاني','Plus':'بلس','Pro':'برو','Max':'ماكس','Choose your plan':'اختر اشتراكك','More room for your ideas.':'مساحة أوسع لأفكارك.','GOLDENSPACEAI MEMBERSHIP':'اشتراكات جولدن سبيس','Find your plan':'اختر الاشتراك المناسب لك','Choose the tools and capacity that fit your day.':'اختر الأدوات وحدود الاستخدام التي تناسب احتياجاتك.','Monthly':'شهري','Yearly':'سنوي','Pay once · 12 months':'دفعة واحدة · ١٢ شهرًا','Most popular':'الأكثر طلبًا','MOST POPULAR':'الأكثر طلبًا','Selected':'تم الاختيار','USD':'دولار أمريكي','Payment status →':'متابعة طلب الدفع ←','OMT Pay · No auto-renewal':'OMT Pay · دون تجديد تلقائي','Choose':'الاختيار','Wallet number':'رقم المحفظة','Accept':'الموافقة','Pay':'الدفع','Add usage credits':'إضافة رصيد للاستخدام','Amount (USD, $2–$200)':'المبلغ بالدولار الأمريكي (من ٢ إلى ٢٠٠ دولار)','OMT Pay wallet number':'رقم محفظة OMT Pay','Request credit top-up':'طلب إضافة رصيد','EXTRA CAPACITY':'استخدام إضافي','Need a little more usage?':'تحتاج إلى رصيد إضافي؟','Explore credit top-ups for your current plan.':'أضف رصيدًا لزيادة استخدام الميزات المتاحة في اشتراكك.','Questions about your subscription?':'لديك استفسار عن اشتراكك؟','View your plan & payment history →':'عرض اشتراكك وسجل المدفوعات ←','Current plan':'اشتراكك الحالي','Latest payment request':'آخر طلب دفع','Waiting':'قيد المراجعة','Approved':'تمت الموافقة','Declined':'مرفوض',
    'Live Voice':'المحادثة الصوتية','Hands-free · short Fast replies':'تحدث بحرية واحصل على إجابات موجزة','Ready':'جاهز للمحادثة','Listening… short pause sends':'أستمع إليك… توقف قليلًا لإرسال كلامك','Generating short reply…':'أحضّر الإجابة…','Speaking…':'أتحدث الآن…','Auto-listening':'الاستماع التلقائي','Paused':'متوقف مؤقتًا','Preparing reply':'جارٍ تحضير الإجابة','Ready for you':'جاهز للاستماع إليك','Tap mute to pause':'اضغط على كتم لإيقاف الاستماع مؤقتًا','Start listening':'بدء الاستماع','Listening…':'أستمع إليك…','Mute':'كتم الميكروفون','Unmute':'تشغيل الميكروفون','Exit':'إنهاء المحادثة','Live chat':'المحادثة الصوتية','Dictate':'الإملاء الصوتي','Your conversation will appear here':'ستظهر محادثتك هنا','Speak naturally. Pause to send. Replies stay short for voice — text and audio follow together.':'تحدث بشكل طبيعي، ثم توقف قليلًا لإرسال كلامك. ستظهر الإجابة مكتوبة وتُقرأ بصوت مسموع.',
    'Compare AI models, voice time, media, and document allowances. Choose monthly or yearly access with a one-time OMT Pay transfer.':'قارن بين النماذج وحدود المحادثات الصوتية والوسائط والمستندات، ثم اختر اشتراكًا شهريًا أو سنويًا وادفع عبر OMT Pay.','Credits never expire and only extend features already included in your current plan. They never unlock Studio or premium models.':'يبقى رصيدك متاحًا دون انتهاء صلاحية، ويمنحك استخدامًا إضافيًا للميزات المشمولة في اشتراكك الحالي. إضافة الرصيد لا تفتح ميزات أو نماذج غير مشمولة في اشتراكك.',
    'Your OMT Pay number':'رقم محفظة OMT Pay الخاصة بك','Review and accept':'المراجعة والموافقة','Send payment via OMT Pay':'الدفع عبر OMT Pay','Amount sent':'أرسلت المبلغ','Amount':'المبلغ','Send to':'التحويل إلى','From (your OMT)':'من محفظتك','Plan':'الاشتراك','Confirm OMT Pay number':'تأكيد رقم محفظة OMT Pay','Enter the wallet number you will send payment from. We use it to match your transfer.':'أدخل رقم المحفظة التي سترسل المبلغ منها حتى نتمكن من مطابقة التحويل مع طلبك.','Wallet-to-wallet transfer. No screenshots required.':'تحويل بين المحافظ، ولا تحتاج إلى إرسال صورة للتحويل.'
  };
  var original = new WeakMap(), attributes = new WeakMap();
  var skip = 'script,style,code,pre,textarea,[contenteditable],#messagesContainer,#liveTranscript,.messages,.message,.studio-message,.message-content,[data-user-content]';
  function translate(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), n;
    while ((n = walker.nextNode())) {
      if (!n.parentElement || n.parentElement.closest(skip)) continue;
      var current = n.nodeValue, saved = original.get(n);
      if (!saved || (current !== saved.en && current !== saved.ar)) {
        var trimmed = current.trim(); if (!words[trimmed]) continue;
        saved = { en: current, ar: current.replace(trimmed, words[trimmed]) }; original.set(n, saved);
      }
      var target = lang === 'ar' ? saved.ar : saved.en;
      if (n.nodeValue !== target) n.nodeValue = target;
    }
    root.querySelectorAll('[placeholder],[aria-label],[title]').forEach(function (el) {
      if (el.closest(skip)) return;
      var saved = attributes.get(el) || {};
      ['placeholder','aria-label','title'].forEach(function (a) {
        var v = el.getAttribute(a); if (!v) return;
        if (!saved[a] || (v !== saved[a].en && v !== saved[a].ar)) { if (!words[v]) return; saved[a] = { en:v, ar:words[v] }; }
        var t = lang === 'ar' ? saved[a].ar : saved[a].en; if (v !== t) el.setAttribute(a,t);
      }); attributes.set(el,saved);
    });
  }
  function apply() {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    if (document.body) translate(document.body);
    var select = document.getElementById('siteLanguage'); if (select) select.value = lang;
  }
  apply();
  function start() {
    var style = document.createElement('style');
    style.textContent = '.site-language{position:fixed;inset-inline-end:18px;bottom:18px;z-index:9999;display:flex;align-items:center;gap:7px;border:1px solid var(--border,#555);border-radius:12px;padding:7px 10px;background:var(--panel,#151923);color:var(--text,#eee);box-shadow:0 4px 20px #0002;font:12px system-ui}.site-language select{font:inherit;color:inherit;background:transparent;border:0;min-height:28px;cursor:pointer}.site-language option{background:var(--panel,#151923);color:var(--text,#eee)}html[lang=ar] body{font-family:Tahoma,"Segoe UI",Arial,sans-serif;letter-spacing:normal}html[dir=rtl] input[type=email],html[dir=rtl] input[type=tel],html[dir=rtl] input[type=password],html[dir=rtl] pre,html[dir=rtl] code{direction:ltr;text-align:left}html[dir=rtl] .message-content,html[dir=rtl] .msg-content,html[dir=rtl] .live-bubble{unicode-bidi:plaintext;text-align:start}html[dir=rtl] .sidebar,html[dir=rtl] #chatsPanel{left:auto;right:0}html[dir=rtl] .plan-card,html[dir=rtl] .credit-topup,html[dir=rtl] .free-strip{text-align:start}html[dir=rtl] .live-transcript:empty::before{content:"ستظهر محادثتك هنا"}@media(max-width:600px){.site-language{bottom:9px;inset-inline-end:10px;padding:4px 8px}}';
    document.head.appendChild(style);
    var box = document.createElement('div'); box.className = 'site-language';
    box.innerHTML = '<span aria-hidden="true">◎</span><select id="siteLanguage" aria-label="Language / اللغة"><option value="en">English</option><option value="ar">العربية</option></select>';
    var host = document.querySelector('.topnav nav, .top-bar-actions, .live-page-top');
    if (host) { box.style.position = 'static'; box.style.flexShrink = '0'; host.appendChild(box); }
    else document.body.appendChild(box);
    box.querySelector('select').addEventListener('change',function(e){lang=e.target.value;try{localStorage.setItem(key,lang);}catch(_){} apply();});
    apply();
    var scheduled = false;
    new MutationObserver(function(){if(scheduled)return;scheduled=true;requestAnimationFrame(function(){scheduled=false;translate(document.body);});}).observe(document.body,{subtree:true,childList:true,characterData:true});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',start); else start();
  window.addEventListener('storage',function(e){if(e.key===key){lang=e.newValue==='ar'?'ar':'en';apply();}});
})();
