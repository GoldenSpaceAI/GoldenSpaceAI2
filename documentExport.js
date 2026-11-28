'use strict';

const JSZip = require('jszip');
const Design = require('./public/presentation-design');
const Composer = require('./public/presentation-composer');
let activeHighlights = [];

const EMU = 914400;
const THEMES = {
    midnight: { bg: '101827', alt: '0D1623', card: '1A2A3B', card2: '1B2D40', accent: 'D4AF37', accent2: '63C7B2', accent3: '8AB4F8', accent4: 'E39B83', accent5: 'A88BE8', accent6: 'C7D0DB', text: 'F7F5EF', body: 'E9EDF1', muted: 'BAC5D1', footer: '92A0AF', title: '172232', wordBody: '263347', secondary: '617184', tertiary: '3D5065', soft: 'F7F1E0', soft2: 'EEF2F6', border: '344457', shade: '233B50', shade2: '1B2B3F' },
    editorial: { bg: 'F7F3EA', alt: 'EFE9DF', card: 'FFFDFA', card2: 'F1E8DB', accent: 'A64036', accent2: '28686C', accent3: '466F9B', accent4: 'B76D45', accent5: '75659A', accent6: '6B665F', text: '27231F', body: '38342F', muted: '6B665F', footer: '847B70', title: '28231F', wordBody: '38342F', secondary: '746D64', tertiary: '514B44', soft: 'F2E8DC', soft2: 'E9E3DA', border: 'D8CEBE', shade: 'E9DED0', shade2: 'E3D5C4' },
    ocean: { bg: '0C2236', alt: '102B43', card: '163950', card2: '1D455C', accent: '41C6B7', accent2: '71AEE8', accent3: '7DD3C7', accent4: 'E7A87D', accent5: 'B2A2E6', accent6: 'C8DCE4', text: 'F1F8FA', body: 'E2EFF3', muted: 'B4D0DA', footer: '8BAAB8', title: '12334D', wordBody: '254C61', secondary: '5A788A', tertiary: '3F6175', soft: 'DCEFF0', soft2: 'E7F1F5', border: '345B70', shade: '1B4259', shade2: '183C53' },
    minimal: { bg: 'F8FAFC', alt: 'EEF2F7', card: 'FFFFFF', card2: 'EEF2F7', accent: '3867D6', accent2: 'D16A51', accent3: '4285A8', accent4: '9B6DB5', accent5: 'D69B2D', accent6: '536274', text: '17202B', body: '263241', muted: '5B6675', footer: '7D8794', title: '17202B', wordBody: '263241', secondary: '657181', tertiary: '475363', soft: 'E8EFFC', soft2: 'E9EEF4', border: 'D6DEE8', shade: 'E6ECF5', shade2: 'DCE5F0' },
    heritage: { bg: '241713', alt: '301F19', card: '3A2720', card2: '493128', accent: 'D8A84E', accent2: 'A7C6A1', accent3: 'D7825F', accent4: '8DA9C4', accent5: 'BE9BD3', accent6: 'E4D7C5', text: 'FFF8EC', body: 'F3E6D2', muted: 'CEBDA7', footer: 'A9957E', title: '38241E', wordBody: '4B342A', secondary: '7E6958', tertiary: '604B3D', soft: 'F6EAD8', soft2: 'EFE4D7', border: '65493A', shade: '53382C', shade2: '422B23' },
    science: { bg: '071A2D', alt: '0A243A', card: '10334B', card2: '12405C', accent: '37D5FF', accent2: '80ED99', accent3: '79A7FF', accent4: 'FFB86B', accent5: 'C29BFF', accent6: 'CBEAF3', text: 'F3FCFF', body: 'DDF4FA', muted: 'A7CBD8', footer: '7DA6B7', title: '0E3148', wordBody: '244B5F', secondary: '577989', tertiary: '3C6274', soft: 'E0F6FA', soft2: 'E9F3F6', border: '28566D', shade: '16435A', shade2: '10364D' },
    forest: { bg: '10251D', alt: '163127', card: '1D3D30', card2: '244A39', accent: 'A8D66D', accent2: '59C3A5', accent3: '89B8E8', accent4: 'E2A36F', accent5: 'B09AD8', accent6: 'D7E4D9', text: 'F6FBF3', body: 'E6F0E5', muted: 'B9CEBA', footer: '8EAA92', title: '18392B', wordBody: '2B4E3C', secondary: '607A68', tertiary: '456453', soft: 'E8F2DF', soft2: 'EDF3EB', border: '385E49', shade: '28543F', shade2: '204533' },
    royal: { bg: '17122E', alt: '211941', card: '2A2250', card2: '352A62', accent: 'F0C75E', accent2: '79D0C3', accent3: '9DB5FF', accent4: 'EF9A7A', accent5: 'D5A5FF', accent6: 'DFD8F2', text: 'FBF9FF', body: 'ECE8F7', muted: 'C7BEDD', footer: '9E94BA', title: '251D48', wordBody: '40375D', secondary: '746B8A', tertiary: '584E72', soft: 'F1EAF9', soft2: 'F0EDF5', border: '4D4370', shade: '3B3068', shade2: '2E2758' },
    sunset: { bg: '30141B', alt: '421B23', card: '53252E', card2: '62303A', accent: 'FFB84D', accent2: 'FF7B72', accent3: '88B7E8', accent4: 'FFD08A', accent5: 'DFA6E8', accent6: 'F3D9D7', text: 'FFF9F5', body: 'F8E8E3', muted: 'D9BDB8', footer: 'B8938D', title: '4B2029', wordBody: '61353C', secondary: '8B6566', tertiary: '704B50', soft: 'F9E9DF', soft2: 'F4ECEA', border: '75434A', shade: '65323B', shade2: '542731' },
    monochrome: { bg: '111111', alt: '1A1A1A', card: '242424', card2: '303030', accent: 'FFFFFF', accent2: 'BEBEBE', accent3: '969696', accent4: 'D4D4D4', accent5: 'A8A8A8', accent6: 'E2E2E2', text: 'FFFFFF', body: 'E8E8E8', muted: 'B8B8B8', footer: '929292', title: '202020', wordBody: '343434', secondary: '666666', tertiary: '4C4C4C', soft: 'F1F1F1', soft2: 'E8E8E8', border: '444444', shade: '343434', shade2: '2A2A2A' },
    classroom: { bg: '14332F', alt: '1B423D', card: '23524B', card2: '2C6259', accent: 'FFD166', accent2: '6EE7C1', accent3: '83B8F4', accent4: 'FF9B85', accent5: 'CBB2FE', accent6: 'E0EFEA', text: 'FFFDF4', body: 'EDF6F2', muted: 'BED8D0', footer: '94B8AE', title: '204B45', wordBody: '345D56', secondary: '68847D', tertiary: '4E7068', soft: 'FFF2C9', soft2: 'E8F3EF', border: '47736A', shade: '32665D', shade2: '28554E' },
    corporate: { bg: '10223E', alt: '162C4D', card: '1E395F', card2: '274872', accent: '5DA9FF', accent2: '5ED0B6', accent3: '8FB8FF', accent4: 'FFAA76', accent5: 'B8A0F2', accent6: 'D8E4F3', text: 'F7FAFF', body: 'E7EEF8', muted: 'B7C6DA', footer: '8DA1BA', title: '193552', wordBody: '2B4964', secondary: '61758C', tertiary: '456078', soft: 'E8F1FF', soft2: 'EDF1F6', border: '3A5A7A', shade: '294A70', shade2: '203B60' },
    creative: { bg: '24122F', alt: '321741', card: '422052', card2: '522964', accent: 'FF6FB5', accent2: '50E3C2', accent3: '7DB1FF', accent4: 'FFB56B', accent5: 'C993FF', accent6: 'EADAF0', text: 'FFF8FF', body: 'F4E7F7', muted: 'D1BBD8', footer: 'AD92B5', title: '3B1D49', wordBody: '563663', secondary: '806788', tertiary: '684D70', soft: 'FBE4F2', soft2: 'F3EAF5', border: '684376', shade: '5A2E6A', shade2: '482455' }
};
const FONT_SYSTEMS = [
    { display: 'Aptos Display', body: 'Aptos' }, { display: 'Arial', body: 'Arial' },
    { display: 'Georgia', body: 'Georgia' }, { display: 'Trebuchet MS', body: 'Trebuchet MS' },
    { display: 'Verdana', body: 'Verdana' }, { display: 'Century Gothic', body: 'Arial' },
    { display: 'Cambria', body: 'Calibri' }, { display: 'Tahoma', body: 'Tahoma' },
    { display: 'Times New Roman', body: 'Arial' }, { display: 'Gill Sans', body: 'Arial' },
    { display: 'Baskerville', body: 'Georgia' }, { display: 'Calibri', body: 'Calibri' }
];
let activePalette = THEMES.midnight;
let activeDesignSeed = 0;
let activeMotif = 0;
let activeFonts = FONT_SYSTEMS[0];
function paletteHex(color) {
    const p = activePalette || THEMES.midnight, value = String(color || '').replace(/^#/, '').toUpperCase();
    const map = {
        '101827':p.bg,'0D1623':p.alt,'172232':p.title,'1A2A3B':p.card,'1B2D40':p.card2,'1A2738':p.card2,'18283A':p.card,'21364A':p.card2,'233B50':p.shade,'1B2B3F':p.shade2,'344457':p.border,
        'D4AF37':p.accent,'A37A11':p.accent,'63C7B2':p.accent2,'8AB4F8':p.accent3,'E39B83':p.accent4,'A88BE8':p.accent5,'C7D0DB':p.accent6,
        'F7F5EF':p.text,'F4F0E7':p.text,'E9EDF1':p.body,'E2E7EC':p.body,'BAC5D1':p.muted,'92A0AF':p.footer,'8491A0':p.footer,
        '263347':p.wordBody,'617184':p.secondary,'33465B':p.tertiary,'3D5065':p.tertiary,'748496':p.secondary,'F7F1E0':p.soft,'EEF2F6':p.soft2
    };
    return map[value] || value;
}
function xmlSafe(value) {
    return Array.from(String(value == null ? '' : value)).filter((char) => {
        const cp = char.codePointAt(0);
        return cp === 9 || cp === 10 || cp === 13 || (cp >= 32 && cp <= 0xD7FF) || (cp >= 0xE000 && cp <= 0xFFFD) || (cp >= 0x10000 && cp <= 0x10FFFF);
    }).join('');
}
const esc = (value) => xmlSafe(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const inch = (value) => String(Math.round(Number(value) * EMU));
const hex = (value, fallback) => {
    const v = paletteHex(value || fallback || '');
    return /^[0-9A-F]{6}$/.test(v) ? v : paletteHex(fallback || activePalette.accent);
};
const safeText = (value, max) => String(value || '').replace(/\u0000/g, '').trim().slice(0, max || 4000);
const arr = (value) => Array.isArray(value) ? value.map((v) => safeText(v, 700)).filter(Boolean).slice(0, 8) : [];

function normalizeArtifact(artifact) {
    if (!artifact || typeof artifact !== 'object') throw new Error('Document content is missing.');
    const slides = Array.isArray(artifact.slides) ? artifact.slides.slice(0, 30) : [];
    if (!slides.length) throw new Error('Add at least one slide or section.');
    const normalized = slides.map((s) => {
        if (!s || !safeText(s.title, 220)) return null;
        return {
            layout: safeText(s.layout, 24).toLowerCase() || 'content',
            eyebrow: safeText(s.eyebrow, 90),
            title: safeText(s.title, 220),
            subtitle: safeText(s.subtitle, 400),
            body: safeText(s.body, 5000),
            bullets: arr(s.bullets),
            stat: safeText(s.stat, 180),
            leftTitle: safeText(s.leftTitle, 160),
            leftBullets: arr(s.leftBullets),
            rightTitle: safeText(s.rightTitle, 160),
            rightBullets: arr(s.rightBullets),
            quote: safeText(s.quote, 700),
            attribution: safeText(s.attribution, 160),
            visual: safeText(s.visual, 300),
            highlights: Design.highlights(s),
            diagram: s.diagram, milestones: s.milestones, chart: s.chart, image: Composer.image(s.image)
        };
    });
    if (normalized.some((s) => !s)) throw new Error('Each slide needs a title.');
    return {
        title: safeText(artifact.title, 180) || 'GoldenSpaceAI Presentation',
        subtitle: safeText(artifact.subtitle, 400),
        theme: Object.prototype.hasOwnProperty.call(THEMES, artifact.theme) ? artifact.theme : Design.chooseTheme(artifact.title),
        designSeed: Math.max(0, Math.min(95, Number(artifact.designSeed) || 0)),
        slides: normalized
    };
}

function para(text, opts) {
    opts = opts || {};
    const size = Math.max(900, Math.min(9600, Number(opts.size) || 1800));
    const color = hex(opts.color, 'F4F0E7');
    const isArabic = /[\u0600-\u06ff]/.test(String(text));
    const align = opts.align || (isArabic ? 'r' : 'l');
    const after = Number.isFinite(opts.after) ? opts.after : 500;
    const typeface = isArabic ? 'Tahoma' : (opts.typeface || (opts.bold && size >= 2200 ? activeFonts.display : activeFonts.body));
    const lang = isArabic ? 'ar-SA' : 'en-US';
    const runs = Design.runs(text, activeHighlights).map(run => {
        const ink = run.tone ? hex(run.tone === 'secondary' ? '63C7B2' : 'D4AF37') : color;
        return '<a:r><a:rPr lang="' + lang + '" sz="' + size + '"' + (opts.bold || run.tone ? ' b="1"' : '') + ' dirty="0"><a:solidFill><a:srgbClr val="' + ink + '"/></a:solidFill><a:latin typeface="' + esc(typeface) + '"/><a:cs typeface="' + esc(typeface) + '"/></a:rPr><a:t xml:space="preserve">' + esc(run.text) + '</a:t></a:r>';
    }).join('');
    return '<a:p><a:pPr algn="' + align + '"' + (isArabic ? ' rtl="1"' : '') + '><a:lnSpc><a:spcPct val="112000"/></a:lnSpc><a:spcAft><a:spcPts val="' + after + '"/></a:spcAft></a:pPr>' + runs + '<a:endParaRPr lang="' + lang + '" sz="' + size + '"/></a:p>';
}
function textBox(id, name, x, y, w, h, paragraphs, opts) {
    opts = opts || {};
    const fill = opts.fill ? '<a:solidFill><a:srgbClr val="' + hex(opts.fill) + '"/></a:solidFill>' : '<a:noFill/>';
    const line = opts.line ? '<a:ln w="9525"><a:solidFill><a:srgbClr val="' + hex(opts.line) + '"/></a:solidFill></a:ln>' : '<a:ln><a:noFill/></a:ln>';
    const radius = opts.round ? 'roundRect' : 'rect';
    const inset = opts.inset == null ? 0 : opts.inset;
    return '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="' + esc(name) + '"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
        '<p:spPr><a:xfrm><a:off x="' + inch(x) + '" y="' + inch(y) + '"/><a:ext cx="' + inch(w) + '" cy="' + inch(h) + '"/></a:xfrm><a:prstGeom prst="' + radius + '"><a:avLst/></a:prstGeom>' + fill + line + '</p:spPr>' +
        '<p:txBody><a:bodyPr wrap="square" anchor="' + (opts.anchor || 't') + '" lIns="' + inch(inset) + '" rIns="' + inch(inset) + '" tIns="' + inch(inset) + '" bIns="' + inch(inset) + '"/><a:lstStyle/>' + paragraphs.join('') + '</p:txBody></p:sp>';
}
function shape(id, name, x, y, w, h, color, geometry) {
    return '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="' + esc(name) + '"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="' + inch(x) + '" y="' + inch(y) + '"/><a:ext cx="' + inch(w) + '" cy="' + inch(h) + '"/></a:xfrm><a:prstGeom prst="' + (geometry || 'rect') + '"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="' + hex(color) + '"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>';
}
function groupTree(shapes) {
    return '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' + shapes.join('') + '</p:spTree>';
}

async function presentationImages(data) {
    const images = new Map(), unique = [...new Map(data.slides.filter(s=>s.image).map(s=>[s.image.url,s.image])).values()].slice(0,4);
    await Promise.all(unique.map(async image=>{
        const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
        try{
            const response=await fetch(image.url,{signal:controller.signal,redirect:'error'});
            const type=String(response.headers.get('content-type')||'').split(';')[0];
            if(!response.ok||!['image/jpeg','image/png'].includes(type)||Number(response.headers.get('content-length'))>5*1024*1024)return;
            const chunks=[];let size=0;for await(const part of response.body){size+=part.length;if(size>5*1024*1024){controller.abort();return;}chunks.push(part);}
            const bytes=Buffer.concat(chunks);if(bytes.length<8)return;
            const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
            const jpg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
            if(!png&&!jpg)return;images.set(image.url,{bytes,extension:png?'png':'jpg'});
        }catch(_){}finally{clearTimeout(timer);}
    }));
    return images;
}
function sceneLine(e,id) {
    const x=Math.min(e.x,e.x+e.w)/96,y=Math.min(e.y,e.y+e.h)/96,w=Math.max(Math.abs(e.w),.1)/96,h=Math.max(Math.abs(e.h),.1)/96;
    return '<p:sp><p:nvSpPr><p:cNvPr id="'+id+'" name="Diagram connection"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm'+(e.w<0?' flipH="1"':'')+(e.h<0?' flipV="1"':'')+'><a:off x="'+inch(x)+'" y="'+inch(y)+'"/><a:ext cx="'+inch(w)+'" cy="'+inch(h)+'"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="9525"><a:solidFill><a:srgbClr val="'+hex(e.color)+'"/></a:solidFill></a:ln></p:spPr></p:sp>';
}
function scenePicture(e,id,rid) {
    const ratio=e.image.width/e.image.height,target=e.w/e.h;
    const crop=ratio>target?{l:Math.round((1-target/ratio)*50000),r:Math.round((1-target/ratio)*50000),t:0,b:0}:{l:0,r:0,t:Math.round((1-ratio/target)*50000),b:Math.round((1-ratio/target)*50000)};
    return '<p:pic><p:nvPicPr><p:cNvPr id="'+id+'" name="Topic photograph" descr="'+esc('Photo: '+e.image.credit+'. '+e.image.source)+'"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="'+rid+'"/><a:srcRect l="'+crop.l+'" r="'+crop.r+'" t="'+crop.t+'" b="'+crop.b+'"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="'+inch(e.x/96)+'" y="'+inch(e.y/96)+'"/><a:ext cx="'+inch(e.w/96)+'" cy="'+inch(e.h/96)+'"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>';
}
function composedSlide(data,index,imageFiles) {
    const scene=Composer.compose(data,index,activePalette),rels=[];
    const shapes=scene.elements.map(e=>{
        const id=e.id+1;
        if(e.type==='rect')return shape(id,'Diagram region',e.x/96,e.y/96,e.w/96,e.h/96,e.color);
        if(e.type==='line')return sceneLine(e,id);
        if(e.type==='image'){const file=imageFiles.get(e.image.url);if(!file)return '';const rid='rId'+(rels.length+2);rels.push({rid,file});return scenePicture(e,id,rid);}
        activeHighlights=e.marks||[];
        return textBox(id,e.role==='title'?'Slide title':'Slide text',e.x/96,e.y/96,e.w/96,e.h/96,[para(e.text,{size:Math.round(e.size*75),typeface:e.font,color:e.color,bold:e.bold,align:e.align,after:0})]);
    });
    return {xml:slideXml(scene.background,shapes),rels};
}
function slideXml(bg, shapes) {
    bg = hex(bg);
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="' + bg + '"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>' +
        groupTree(shapes) + '</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
}
function powerpointXml(data, assets) {
    const zip = new JSZip();
    const count = data.slides.length;
    const imageFiles = new Map();let mediaIndex=0;for(const [url,image] of assets){const file='photo'+(++mediaIndex)+'.'+image.extension;zip.file('ppt/media/'+file,image.bytes);imageFiles.set(url,file);}
    const ids = data.slides.map((_, i) => '<p:sldId id="' + (256 + i) + '" r:id="rId' + (i + 2) + '"/>').join('');
    zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="png" ContentType="image/png"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' + data.slides.map((_, i) => '<Override PartName="/ppt/slides/slide' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>').join('') + '</Types>');
    zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>');
    zip.file('docProps/core.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>' + esc(data.title) + '</dc:title><dc:creator>GoldenSpaceAI</dc:creator><cp:lastModifiedBy>GoldenSpaceAI</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z</dcterms:modified></cp:coreProperties>');
    zip.file('docProps/app.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>GoldenSpaceAI</Application><PresentationFormat>On-screen Show (16:9)</PresentationFormat><Slides>' + count + '</Slides><Notes>0</Notes><HiddenSlides>0</HiddenSlides><MMClips>0</MMClips><ScaleCrop>false</ScaleCrop><Company>GoldenSpaceAI</Company><AppVersion>1.0</AppVersion></Properties>');
    zip.file('ppt/presentation.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>' + ids + '</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>');
    zip.file('ppt/_rels/presentation.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>' + data.slides.map((_, i) => '<Relationship Id="rId' + (i + 2) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide' + (i + 1) + '.xml"/>').join('') + '</Relationships>');
    const grp = groupTree([]);
    zip.file('ppt/slideMasters/slideMaster1.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="GoldenSpaceAI Master">' + grp + '</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="3200" b="1"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr marL="0" indent="0"><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:otherStyle></p:txStyles></p:sldMaster>');
    zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>');
    zip.file('ppt/slideLayouts/slideLayout1.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Blank">' + grp + '</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>');
    zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>');
    const themeXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="GoldenSpaceAI"><a:themeElements><a:clrScheme name="GoldenSpaceAI"><a:dk1><a:srgbClr val="101827"/></a:dk1><a:lt1><a:srgbClr val="F7F5EF"/></a:lt1><a:dk2><a:srgbClr val="0D1623"/></a:dk2><a:lt2><a:srgbClr val="E9EDF1"/></a:lt2><a:accent1><a:srgbClr val="D4AF37"/></a:accent1><a:accent2><a:srgbClr val="63C7B2"/></a:accent2><a:accent3><a:srgbClr val="8AB4F8"/></a:accent3><a:accent4><a:srgbClr val="E39B83"/></a:accent4><a:accent5><a:srgbClr val="A88BE8"/></a:accent5><a:accent6><a:srgbClr val="C7D0DB"/></a:accent6><a:hlink><a:srgbClr val="8AB4F8"/></a:hlink><a:folHlink><a:srgbClr val="A88BE8"/></a:folHlink></a:clrScheme><a:fontScheme name="GoldenSpaceAI"><a:majorFont><a:latin typeface="Aptos Display"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="GoldenSpaceAI"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:lumMod val="80000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:lumMod val="60000"/></a:schemeClr></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:lumMod val="95000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:lumMod val="90000"/></a:schemeClr></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>'
    .replaceAll('101827', activePalette.bg).replaceAll('0D1623', activePalette.alt).replaceAll('F7F5EF', activePalette.text).replaceAll('E9EDF1', activePalette.body)
    .replaceAll('D4AF37', activePalette.accent).replaceAll('63C7B2', activePalette.accent2).replaceAll('8AB4F8', activePalette.accent3)
    .replaceAll('E39B83', activePalette.accent4).replaceAll('A88BE8', activePalette.accent5).replaceAll('C7D0DB', activePalette.accent6);
    zip.file('ppt/theme/theme1.xml', themeXml);
    data.slides.forEach((s, i) => {
        const scene = composedSlide(data,i,imageFiles);
        zip.file('ppt/slides/slide'+(i+1)+'.xml',scene.xml);
        zip.file('ppt/slides/_rels/slide'+(i+1)+'.xml.rels','<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'+scene.rels.map(r=>'<Relationship Id="'+r.rid+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/'+r.file+'"/>').join('')+'</Relationships>');
    });
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// Word sizes are expressed in half-points. Keep body text at 14 pt.
const WORD_BODY_SIZE = 28;
const WORD_MIN_SIZE = 24;

function wordParagraph(text, opts) {
    opts = opts || {};
    const style = opts.style ? '<w:pStyle w:val="' + opts.style + '"/>' : '';
    const color = hex(opts.color, '263347');
    const size = Math.max(WORD_MIN_SIZE, Math.min(64, Number(opts.size) || WORD_BODY_SIZE));
    const bold = opts.bold ? '<w:b/>' : '';
    const italic = opts.italic ? '<w:i/>' : '';
    const pPr = style + (opts.shading ? '<w:shd w:fill="' + hex(opts.shading) + '" w:val="clear"/>' : '') + (opts.indent ? '<w:ind w:left="420" w:hanging="200"/>' : '') + (opts.after ? '<w:spacing w:after="' + opts.after + '" w:line="300" w:lineRule="auto"/>' : '');
    return '<w:p><w:pPr>' + pPr + '</w:pPr><w:r><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/><w:color w:val="' + color + '"/><w:sz w:val="' + size + '"/><w:szCs w:val="' + size + '"/>' + bold + italic + '</w:rPr><w:t xml:space="preserve">' + esc(text) + '</w:t></w:r></w:p>';
}
function wordXml(data) {
    const parts = [];
    parts.push(wordParagraph('GOLDENSPACEAI  ·  FIELD NOTES', { color: 'A37A11', size: 20, bold: true, after: 240 }));
    parts.push(wordParagraph(data.title, { color: '172232', size: 52, bold: true, after: 280 }));
    if (data.subtitle) parts.push(wordParagraph(data.subtitle, { color: '617184', size: 26, after: 500 }));
    parts.push(wordParagraph('A clear, structured document prepared with GoldenSpaceAI.', { color: '8491A0', size: 20 }));
    parts.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    data.slides.forEach((slide, i) => {
        parts.push(wordParagraph(String(i + 1).padStart(2, '0') + '  ·  ' + (slide.eyebrow || 'SECTION').toUpperCase(), { color: 'A37A11', size: 18, bold: true, after: 100 }));
        parts.push(wordParagraph(slide.title, { style: 'Heading1', color: '172232', size: 34, bold: true, after: 180 }));
        if (slide.subtitle) parts.push(wordParagraph(slide.subtitle, { color: '617184', size: WORD_BODY_SIZE, italic: true, after: 200 }));
        if (slide.body) parts.push(wordParagraph(slide.body, { color: '263347', size: WORD_BODY_SIZE, after: 220 }));
        if (slide.stat) parts.push(wordParagraph(slide.stat, { color: 'A37A11', size: 38, bold: true, shading: 'F7F1E0', after: 240 }));
        if (slide.quote) {
            parts.push(wordParagraph('“' + slide.quote + '”', { color: '33465B', size: 28, italic: true, shading: 'EEF2F6', after: 200 }));
            if (slide.attribution) parts.push(wordParagraph('— ' + slide.attribution, { color: 'A37A11', size: 20, bold: true, after: 180 }));
        }
        slide.bullets.concat(slide.leftBullets, slide.rightBullets).forEach((bullet) => parts.push(wordParagraph('•  ' + bullet, { color: '263347', size: WORD_BODY_SIZE, indent: true, after: 100 })));
        if (slide.leftTitle || slide.rightTitle) {
            if (slide.leftTitle) parts.push(wordParagraph(slide.leftTitle + ': ' + slide.leftBullets.join(' · '), { color: '3D5065', size: WORD_BODY_SIZE, after: 130 }));
            if (slide.rightTitle) parts.push(wordParagraph(slide.rightTitle + ': ' + slide.rightBullets.join(' · '), { color: '3D5065', size: WORD_BODY_SIZE, after: 130 }));
        }
        if (slide.visual) parts.push(wordParagraph('Visual direction: ' + slide.visual, { color: '748496', size: 18, italic: true, after: 260 }));
    });
    const doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + parts.join('') + '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="540" w:footer="540" w:gutter="0"/></w:sectPr></w:body></w:document>';
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', doc);
    zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
    zip.file('word/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/><w:sz w:val="' + WORD_BODY_SIZE + '"/><w:szCs w:val="' + WORD_BODY_SIZE + '"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:rFonts w:ascii="Aptos Display" w:hAnsi="Aptos Display"/><w:color w:val="172232"/><w:b/><w:sz w:val="52"/><w:szCs w:val="52"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="260" w:after="140"/></w:pPr><w:rPr><w:rFonts w:ascii="Aptos Display" w:hAnsi="Aptos Display"/><w:color w:val="172232"/><w:b/><w:sz w:val="34"/><w:szCs w:val="34"/></w:rPr></w:style></w:styles>');
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function createOfficeDocument(artifact, format) {
    const data = normalizeArtifact(artifact);
    const assets=format==='pptx'?await presentationImages(data):new Map();
    if(format==='pptx')data.slides.forEach(s=>{if(s.image&&!assets.has(s.image.url))s.image=null;});
    activePalette = THEMES[data.theme] || THEMES.midnight;
    activeDesignSeed = data.designSeed;
    activeMotif = activeDesignSeed % 8;
    activeFonts = FONT_SYSTEMS[Math.floor(activeDesignSeed / 8) % FONT_SYSTEMS.length];
    if (format === 'pptx') return powerpointXml(data, assets);
    if (format === 'docx') return wordXml(data);
    throw new Error('Choose PowerPoint or Word format.');
}
module.exports = { createOfficeDocument };

