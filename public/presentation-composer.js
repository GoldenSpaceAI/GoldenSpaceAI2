(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./presentation-design'));else root.PresentationComposer=factory(root.PresentationDesign);})(typeof globalThis!=='undefined'?globalThis:this,function(Design){
'use strict';
const W=1280,H=720;
const clean=(v,n=240)=>String(v==null?'':v).replace(/\*\*|__|\x60/g,'').replace(/\s+/g,' ').trim().slice(0,n);
const list=(a,n=4)=>Array.isArray(a)?a.map(x=>clean(x,160)).filter(Boolean).slice(0,n):[];
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const hex=s=>/^#?[a-f\d]{6}$/i.test(String(s))?'#'+String(s).replace('#',''):'#FFFFFF';
function image(value){if(!value||typeof value!=='object')return null;try{const u=new URL(value.url);if(u.protocol!=='https:'||u.hostname!=='images.pexels.com')return null;return {url:u.href,width:Number(value.width)||1200,height:Number(value.height)||900,credit:clean(value.credit,100),source:clean(value.source,1000)};}catch(_){return null;}}
function normalize(s){
 s=Object.assign({},s||{});
 s.title=clean(s.title,110)||'Untitled';s.subtitle=clean(s.subtitle,180);s.body=clean(s.body,270);s.eyebrow=clean(s.eyebrow,55);
 s.bullets=list(s.bullets);s.leftBullets=list(s.leftBullets,3);s.rightBullets=list(s.rightBullets,3);
 s.leftTitle=clean(s.leftTitle,65);s.rightTitle=clean(s.rightTitle,65);s.stat=clean(s.stat,35);s.quote=clean(s.quote,250);s.attribution=clean(s.attribution,90);
 s.imageQuery=clean(s.imageQuery,90);s.image=image(s.image);s.highlights=Design.highlights(s);
 s.diagram=s.diagram&&typeof s.diagram==='object'?{kind:s.diagram.kind==='hub'?'hub':'flow',center:clean(s.diagram.center,50),nodes:(Array.isArray(s.diagram.nodes)?s.diagram.nodes:[]).slice(0,4).map(x=>({label:clean(x.label,48),detail:clean(x.detail,120)})).filter(x=>x.label)}:null;
 s.milestones=(Array.isArray(s.milestones)?s.milestones:[]).slice(0,4).map(x=>({label:clean(x.label,30),detail:clean(x.detail,140)})).filter(x=>x.label&&x.detail);
 s.chart=s.chart&&typeof s.chart==='object'?{unit:clean(s.chart.unit,25),source:clean(s.chart.source,160),items:(Array.isArray(s.chart.items)?s.chart.items:[]).slice(0,5).map(x=>({label:clean(x.label,55),value:Number(x.value)})).filter(x=>x.label&&Number.isFinite(x.value)&&x.value>=0)}:null;
 return s;
}
function choose(s,i,total){
 if(total>1&&i===0)return 'cover';
 if(s.layout==='quote'&&s.quote&&s.attribution)return 'quote';
 if(s.layout==='chart'&&s.chart&&s.chart.items.length>1)return 'chart';
 if(s.layout==='stat'&&s.stat)return 'stat';
 if(s.layout==='compare'&&s.leftBullets.length&&s.rightBullets.length)return 'compare';
 if(s.diagram&&s.diagram.nodes.length>1)return 'diagram';
 if(s.milestones.length>1)return 'timeline';
 if(['timeline','process'].includes(s.layout)&&s.bullets.length>1)return s.layout;
 if(s.image&&['image','cover','content','editorial'].includes(s.layout))return 'image';
 if(s.layout==='closing'&&i===total-1)return 'closing';
 return 'editorial';
}
function same(a,b){return clean(a).toLowerCase().replace(/[^\p{L}\p{N}]/gu,'')===clean(b).toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');}
function lines(text,width,size){
 let used=0,count=1;for(const word of String(text).split(/\s+/)){const ww=Array.from(word).reduce((n,c)=>n+(c.charCodeAt(0)>1500?.66:/[MW@]/.test(c)?.85:/[il.,'!]/.test(c)?.27:.53),0)*size;if(used&&used+ww>width){count++;used=ww;}else used+=ww+size*.3;}return count;
}
function compose(deck,index,palette){
 const p={bg:hex(palette.bg),alt:hex(palette.alt||palette.bg),card:hex(palette.card||palette.alt||palette.bg),accent:hex(palette.accent),accent2:hex(palette.accent2||palette.accent),text:hex(palette.text),body:hex(palette.body||palette.text),muted:hex(palette.muted||palette.body||palette.text)};
 const all=Array.isArray(deck.slides)?deck.slides:[],s=normalize(all[index]),layout=choose(s,index,all.length),els=[];
 const serif=['heritage','editorial','royal'].includes(deck.theme),font=serif?'Georgia':'Arial',bodyFont='Arial',rtl=/[\u0600-\u06ff]/.test(s.title+s.body),align=rtl?'r':'l';
 const bg=p.bg,ink=p.text;let n=0;
 function txt(text,x,y,w,h,size=24,opts={}){
  if(!text)return;let actual=size;const value=String(text);while(actual>(opts.min||size*.8)&&lines(value,w,actual)*actual*1.16>h)actual-=1;
  els.push({type:'text',id:++n,text:value,x,y,w,h,size:actual,font:opts.display?font:bodyFont,color:opts.color||p.body,bold:!!opts.bold,align:opts.align||align,marks:opts.marks===false?[]:s.highlights,field:opts.field||'',role:opts.role||'',rtl});
 }
 function rect(x,y,w,h,color){els.push({type:'rect',id:++n,x,y,w,h,color});}
 function line(x,y,w,h,color=p.muted){els.push({type:'line',id:++n,x,y,w,h,color});}
 function img(im,x,y,w,h){els.push({type:'image',id:++n,x,y,w,h,image:im});}
 function heading(){if(s.eyebrow)txt(s.eyebrow,64,40,1050,26,15,{color:p.accent,bold:true,field:'eyebrow'});txt(s.title,64,89,1152,116,48,{display:true,bold:true,color:ink,field:'title',role:'title'});}
 function intro(y=210,w=1080){const v=s.subtitle||s.body;if(v)txt(v,64,y,w,76,24,{color:p.muted,field:s.subtitle?'subtitle':'body'});}
 function point(text,x,y,w,h,field,color=p.accent,number){
  const split=text.match(/^([^:：]{3,48})[:：]\s*(.+)$/);
  if(number!=null)txt(String(number).padStart(2,'0'),x,y,42,38,22,{bold:true,color,marks:false});
  const xx=number!=null?x+60:x;
  if(split){txt(split[1],xx,y,w-(xx-x),48,27,{bold:true,color:ink});txt(split[2],xx,y+51,w-(xx-x),h-51,23,{field,color:p.body});els[els.length-1].prefix=split[1]+': ';}
  else txt(text,xx,y,w-(xx-x),h,27,{field,color:p.body});
 }
 if(layout==='cover'){
  const has=!!s.image,tw=has?630:960;
  if(has)img(s.image,760,0,520,H);
  if(s.eyebrow)txt(s.eyebrow,64,70,tw,30,16,{color:p.accent,bold:true,field:'eyebrow'});
  txt(s.title||deck.title,64,158,tw,280,76,{display:true,bold:true,color:ink,field:'title',role:'title',min:54});
  const sub=s.subtitle||deck.subtitle||s.body;if(sub)txt(sub,68,475,has?610:900,105,27,{color:p.muted,field:s.subtitle?'subtitle':'body'});
  line(68,628,has?610:1140,1,p.accent);
 }else if(layout==='image'){
  img(s.image,720,0,560,H);if(s.eyebrow)txt(s.eyebrow,64,42,600,26,15,{color:p.accent,bold:true,field:'eyebrow'});
  txt(s.title,64,101,600,170,50,{display:true,bold:true,color:ink,field:'title',role:'title'});
  const points=s.bullets.length?s.bullets:[s.body||s.subtitle].filter(Boolean);
  points.slice(0,3).forEach((v,i)=>{line(64,319+i*99,596,1,p.muted);txt(v,64,339+i*99,596,78,24,{field:s.bullets.length?'bullets.'+i:'body'});});
 }else if(layout==='diagram'){
  heading();intro(205);const nodes=s.diagram.nodes;
  if(s.diagram.kind==='hub'){
   const cx=640,cy=463;const pos=[[64,320],[898,320],[64,519],[898,519]];
   nodes.forEach((v,i)=>{const [x,y]=pos[i];if(i%2)line(cx+150,cy,x-(cx+150),y+32-cy,p.muted);else line(x+318,y+32,cx-150-(x+318),cy-(y+32),p.muted);});
   rect(cx-150,cy-62,300,124,p.accent);txt(s.diagram.center||s.title,cx-130,cy-39,260,80,30,{bold:true,color:p.bg,align:'ctr',field:'diagram.center',marks:false});
   nodes.forEach((v,i)=>{const [x,y]=pos[i];txt(v.label,x,y,318,48,28,{bold:true,color:i%2?p.accent2:p.accent,field:'diagram.nodes.'+i+'.label'});txt(v.detail,x,y+52,318,95,22,{field:'diagram.nodes.'+i+'.detail'});});
  }else{
   const count=nodes.length,col=1152/count;
   nodes.forEach((v,i)=>{const x=64+i*col;rect(x,338,col-24,65,i%2?p.card:p.alt);txt(v.label,x+16,354,col-56,45,25,{bold:true,color:ink,field:'diagram.nodes.'+i+'.label'});if(i<count-1)line(x+col-22,371,20,1,p.accent);txt(v.detail,x,437,col-32,150,23,{field:'diagram.nodes.'+i+'.detail'});});
  }
 }else if(layout==='compare'){
  heading();intro();line(640,320,1,293,p.muted);
  [[s.leftTitle,s.leftBullets,64,'left',p.accent],[s.rightTitle,s.rightBullets,700,'right',p.accent2]].forEach(([label,items,x,key,color])=>{
   txt(label,x,315,510,48,31,{bold:true,color,field:key+'Title'});items.forEach((v,i)=>txt(v,x,389+i*78,510,69,24,{field:key+'Bullets.'+i}));
  });
 }else if(layout==='timeline'||layout==='process'){
  heading();intro();const steps=s.milestones.length?s.milestones:s.bullets.map((v,i)=>({label:String(i+1).padStart(2,'0'),detail:v})),col=1152/steps.length;
  line(66,398,1100,1,p.muted);
  steps.forEach((v,i)=>{const x=64+i*col;rect(x,391,14,14,p.accent);txt(v.label,x,321,col-22,52,32,{bold:true,color:p.accent,field:s.milestones.length?'milestones.'+i+'.label':''});txt(v.detail,x,430,col-60,170,23,{field:s.milestones.length?'milestones.'+i+'.detail':'bullets.'+i});});
 }else if(layout==='chart'){
  heading();intro();const items=s.chart.items,max=Math.max(...items.map(x=>x.value),1),gap=290/items.length;
  items.forEach((v,i)=>{const y=310+i*gap;txt(v.label,64,y,260,gap-8,23,{field:'chart.items.'+i+'.label'});rect(355,y+4,Math.max(3,v.value/max*650),24,i%2?p.accent2:p.accent);txt(String(v.value)+(s.chart.unit?' '+s.chart.unit:''),1036,y-3,174,gap-8,23,{bold:true,color:ink,field:'chart.items.'+i+'.value',marks:false});});
  if(s.chart.source)txt(s.chart.source,64,624,1140,28,14,{color:p.muted,field:'chart.source'});
 }else if(layout==='stat'){
  heading();txt(s.stat,64,300,540,160,112,{color:p.accent,bold:true,field:'stat',marks:false,min:70});
  const body=s.body||s.subtitle;txt(body,68,482,500,125,26,{color:p.muted,field:s.body?'body':'subtitle'});
  s.bullets.slice(0,3).forEach((v,i)=>{line(705,305+i*104,500,1,p.muted);txt(v,705,325+i*104,500,85,25,{field:'bullets.'+i});});
 }else if(layout==='quote'){
  if(s.eyebrow)txt(s.eyebrow,80,64,1110,26,15,{color:p.accent,bold:true,field:'eyebrow'});
  txt('“'+s.quote+'”',80,185,1110,330,51,{display:true,color:ink,field:'quote',min:38});line(84,559,90,2,p.accent);txt(s.attribution,199,542,950,50,24,{color:p.accent,field:'attribution'});
 }else if(layout==='closing'){
  heading();const body=s.body||s.subtitle;txt(body,64,232,980,110,32,{color:p.muted,field:s.body?'body':'subtitle'});
  s.bullets.slice(0,3).forEach((v,i)=>{line(64,381+i*83,1146,1,p.muted);point(v,64,401+i*83,1146,65,'bullets.'+i,p.accent,i+1);});
 }else{
  heading();const points=s.bullets;
  const introText=s.subtitle||s.body;
  if(introText&&!points.some(v=>same(v,introText)))intro(215);
  if(points.length>1){
   points.forEach((v,i)=>{const two=points.length>2,x=two?64+(i%2)*610:64,y=two?345+Math.floor(i/2)*143:340+i*131,w=two?540:1140;line(x,y-16,w,1,p.muted);point(v,x,y,w,two?112:100,'bullets.'+i,i%2?p.accent2:p.accent,i+1);});
  }else if(points.length)txt(points[0],64,352,1140,225,42,{field:'bullets.0',display:true,color:ink});
  else if(s.body)txt(s.body,64,330,1140,260,35,{field:'body',color:ink});
 }
 if(s.image&&['cover','image'].includes(layout)&&s.image.credit){const x=layout==='cover'?760:720;rect(x,655,1280-x,65,p.bg);txt('Pexels / '+s.image.credit,x+20,675,320,20,12,{color:p.muted,marks:false});}
 txt(String(index+1).padStart(2,'0')+' / '+String(all.length).padStart(2,'0'),1120,675,96,24,13,{color:p.muted,align:'r',marks:false});
 return {width:W,height:H,background:bg,layout,elements:els};
}
function html(scene){
 return '<div class="deck-scene" style="background:'+scene.background+'">'+scene.elements.map(e=>{
 const pos='left:'+e.x/W*100+'%;top:'+e.y/H*100+'%;width:'+e.w/W*100+'%;height:'+e.h/H*100+'%;';
 if(e.type==='image')return '<img class="scene-object" draggable="false" src="'+escape(e.image.url)+'" alt="" style="'+pos+'object-fit:cover"/>';
 if(e.type==='line'){const x2=e.w,y2=e.h;return '<svg class="scene-connector" style="left:'+Math.min(e.x,e.x+x2)/W*100+'%;top:'+Math.min(e.y,e.y+y2)/H*100+'%;width:'+Math.max(Math.abs(x2),1)/W*100+'%;height:'+Math.max(Math.abs(y2),1)/H*100+'%" viewBox="0 0 '+Math.max(Math.abs(x2),1)+' '+Math.max(Math.abs(y2),1)+'" preserveAspectRatio="none"><line x1="'+(x2<0?Math.abs(x2):0)+'" y1="'+(y2<0?Math.abs(y2):0)+'" x2="'+(x2<0?0:Math.abs(x2))+'" y2="'+(y2<0?0:Math.abs(y2))+'" stroke="'+e.color+'" stroke-width="1.4" vector-effect="non-scaling-stroke"/></svg>';}
 if(e.type==='rect')return '<div class="scene-object" style="'+pos+'background:'+e.color+'"></div>';
 const runs=Design.runs(e.text,e.marks).map(r=>r.tone?'<span style="color:var(--scene-'+(r.tone==='secondary'?'accent2':'accent')+')">'+escape(r.text)+'</span>':escape(r.text)).join('');
 return '<div class="scene-object scene-text" '+(e.field?'data-field="'+escape(e.field)+'" contenteditable="false"':'')+' data-prefix="'+escape(e.prefix||'')+'" data-role="'+escape(e.role)+'" dir="'+(e.rtl?'rtl':'ltr')+'" style="'+pos+'font-size:'+e.size/12.8+'cqw;font-family:'+escape(e.font)+';color:'+e.color+';font-weight:'+(e.bold?700:400)+';text-align:'+(e.align==='ctr'?'center':e.align==='r'?'right':'left')+'">'+runs+'</div>';
 }).join('')+'</div>';
}
const prompt='Act as a presentation designer and subject specialist. Plan a clear story, then choose a useful visual structure for every slide. Return ONLY valid JSON shaped as {\"title\":\"...\",\"subtitle\":\"...\",\"theme\":\"science\",\"slides\":[{\"layout\":\"cover\",\"title\":\"...\"}]}. Each slide supports: layout (cover, editorial, image, compare, diagram, timeline, process, chart, stat, quote, closing), title, eyebrow, subtitle, body, bullets, titleHighlight, highlights, imageQuery, leftTitle/leftBullets/rightTitle/rightBullets, stat, quote/attribution, diagram:{kind:"hub|flow",center:"...",nodes:[{label:"...",detail:"..."}]}, milestones:[{label:"date or step",detail:"..."}], chart:{unit:"...",source:"...",items:[{label:"...",value:0}]}. Use only the fields that suit that slide. A deck is a narrative, not a stack of bullet lists: use at least 3 appropriate layout types for decks of 5 or more slides and never repeat an interior layout consecutively. Prefer a relationship diagram for mechanisms or concentrations of influence, a timeline for real dated developments, a comparison for meaningful alternatives, and a chart only for supplied or sourced numeric data. Do not fabricate numbers, quotations, citations, dates, or percentages for visual effect. Never turn qualitative claims into numeric charts. Keep each slide to one idea: title under 9 words, at most 4 short supporting points, body one sentence maximum. Do not repeat the same sentence in subtitle, body, and bullets. Label diagram nodes in 1-4 words with a short explanation. Use 3-4 nodes maximum. Give cover and at most one image slide a literal 2-5 word imageQuery suitable for finding relevant stock photography. Do not request generic AI art. Choose one coherent theme: heritage for history, science for science/AI, forest for environment, corporate for business, editorial for humanities, creative for art, ocean for health. Use exact text in titleHighlight and highlights with accent/secondary tones. Match exactly the requested slide count, including cover and ending. Do not add empty or filler slides. All content must be accurate, specific, readable, and useful to its intended audience. Avoid template filler, excessive labels, giant paragraphs, and raw Markdown. The website renders the visual design. Never return HTML.';
if(typeof document!=='undefined'){
 const labels=()=>{const ar=document.documentElement.lang==='ar',count=document.getElementById('designCount'),restyle=document.getElementById('remixDesign');if(count)count.textContent=ar?'تصميم يتكيّف مع المحتوى':'Adaptive slide design';if(restyle)restyle.textContent=ar?'تغيير الأسلوب':'Restyle deck';};
 new MutationObserver(labels).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',labels);else labels();
}
return {compose,html,normalize,choose,prompt,image};
});
