const test=require('node:test'),assert=require('node:assert/strict'),Zip=require('jszip');
const {createOfficeDocument}=require('../documentExport'),C=require('../public/presentation-composer');
const palette={bg:'071A2D',alt:'0A243A',card:'10334B',accent:'37D5FF',accent2:'80ED99',text:'F3FCFF',body:'DDF4FA',muted:'A7CBD8'};
const deck={title:'AI infrastructure',theme:'science',slides:[{title:'AI infrastructure',image:{url:'https://images.pexels.com/photos/1/test.png',width:1,height:1,credit:'Test',source:'https://www.pexels.com/'}},{title:'Resources and access',diagram:{kind:'hub',center:'AI',nodes:[{label:'Compute',detail:'Hardware runs models.'},{label:'Data',detail:'Data supports evaluation.'}]}},{title:'خصائص الموجة',diagram:{kind:'flow',nodes:[{label:'السعة',detail:'أقصى إزاحة عن موضع الاتزان.'},{label:'التردد',detail:'عدد الاهتزازات في الثانية.'}]}}]};
test('semantic layouts preserve structure, escape text and reject unsafe image URLs',()=>{
 const scene=C.compose(deck,1,palette);assert.equal(scene.layout,'diagram');assert.equal(scene.elements.filter(e=>e.type==='line').length,2);assert.ok(scene.elements.some(e=>e.text==='Compute'));
 const unsafe={slides:[{title:'<img src=x onerror=alert(1)>'}]};assert.ok(!C.html(C.compose(unsafe,0,palette)).includes('<img src=x'));
 assert.equal(C.image({url:'https://127.0.0.1/internal'}),null);assert.equal(C.image({url:'http://images.pexels.com/photo.jpg'}),null);
 assert.equal(C.choose(C.normalize({layout:'chart',title:'No data'}),1,3),'editorial');
});
test('PowerPoint embeds images, keeps editable evidence and supports Arabic and single slides',async()=>{
 const prior=global.fetch;global.fetch=async()=>new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'),{headers:{'content-type':'image/png'}});
 try{
 const bytes=await createOfficeDocument(deck,'pptx'),zip=await Zip.loadAsync(bytes);assert.ok(zip.file('ppt/media/photo1.png'));
 for(let i=1;i<=3;i++){const xml=await zip.file('ppt/slides/slide'+i+'.xml').async('string');const ids=[...xml.matchAll(/<p:cNvPr id="(\d+)"/g)].map(x=>x[1]);assert.ok(ids.length>1);assert.equal(ids.length,new Set(ids).size);}
 const diagram=await zip.file('ppt/slides/slide2.xml').async('string');assert.ok(diagram.includes('Compute'));assert.ok(diagram.includes('Data'));assert.ok(!diagram.includes('•'));
 assert.ok((await zip.file('ppt/slides/slide3.xml').async('string')).includes('rtl="1"'));
 assert.ok((await createOfficeDocument({title:'One slide',slides:[{title:'One slide'}]},'pptx')).length>1000);
 }finally{global.fetch=prior;}
});
