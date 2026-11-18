'use strict';

const JSZip = require('jszip');

const EMU = 914400;
const esc = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const inch = (value) => String(Math.round(Number(value) * EMU));
const hex = (value, fallback) => {
    const v = String(value || fallback || '').replace(/^#/, '').toUpperCase();
    return /^[0-9A-F]{6}$/.test(v) ? v : (fallback || 'D4AF37');
};
const safeText = (value, max) => String(value || '').replace(/\u0000/g, '').trim().slice(0, max || 4000);
const arr = (value) => Array.isArray(value) ? value.map((v) => safeText(v, 700)).filter(Boolean).slice(0, 8) : [];

function normalizeArtifact(artifact) {
    if (!artifact || typeof artifact !== 'object') throw new Error('Document content is missing.');
    const slides = Array.isArray(artifact.slides) ? artifact.slides.slice(0, 30) : [];
    if (slides.length < 3) throw new Error('A presentation needs at least three slides.');
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
            visual: safeText(s.visual, 300)
        };
    });
    if (normalized.some((s) => !s)) throw new Error('Each slide needs a title.');
    return {
        title: safeText(artifact.title, 180) || 'GoldenSpaceAI Presentation',
        subtitle: safeText(artifact.subtitle, 400),
        slides: normalized
    };
}

function para(text, opts) {
    opts = opts || {};
    const size = Math.max(900, Math.min(4400, Number(opts.size) || 1800));
    const color = hex(opts.color, 'F4F0E7');
    const bold = opts.bold ? ' b="1"' : '';
    const align = opts.align ? ' algn="' + opts.align + '"' : '';
    const after = Number.isFinite(opts.after) ? opts.after : 500;
    return '<a:p><a:pPr' + align + '><a:lnSpc><a:spcPct val="108000"/></a:lnSpc><a:spcAft><a:spcPts val="' + after + '"/></a:spcAft></a:pPr>' +
        '<a:r><a:rPr lang="en-US" sz="' + size + '"' + bold + ' dirty="0"><a:solidFill><a:srgbClr val="' + color + '"/></a:solidFill><a:latin typeface="Aptos"/></a:rPr><a:t xml:space="preserve">' + esc(text) + '</a:t></a:r>' +
        '<a:endParaRPr lang="en-US" sz="' + size + '"/></a:p>';
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
function coverSlide(data, slideNo, total, closing) {
    const bg = closing ? '172232' : '101827';
    const c = [shape(2, 'Gold accent', 0.72, 0.84, 0.12, 5.65, 'D4AF37', 'roundRect'),
        shape(3, 'Backdrop arc', 9.15, 0.52, 3.5, 3.5, '1B2B3F', 'ellipse'),
        shape(4, 'Backdrop highlight', 10.1, 1.48, 1.6, 1.6, '233B50', 'ellipse')];
    const label = data.eyebrow || (closing ? 'KEY TAKEAWAYS' : 'GOLDENSPACEAI  ·  PRESENTATION');
    c.push(textBox(5, 'Eyebrow', 1.15, 1.12, 9.2, 0.38, [para(label.toUpperCase(), { size: 1050, color: 'D4AF37', bold: true, after: 0 })]));
    c.push(textBox(6, 'Title', 1.12, 1.72, 10.4, 2.05, [para(data.title, { size: closing ? 3200 : 3500, color: 'F7F5EF', bold: true, after: 300 })]));
    const sub = data.subtitle || data.body || data.bullets.join('  ·  ');
    if (sub) c.push(textBox(7, 'Subtitle', 1.16, 4.0, 9.8, 1.05, [para(sub, { size: 1650, color: 'BAC5D1', after: 0 })]));
    c.push(shape(8, 'Gold divider', 1.16, 5.42, 1.15, 0.045, 'D4AF37'));
    c.push(textBox(9, 'Footer', 10.65, 6.86, 1.8, 0.28, [para(String(slideNo).padStart(2, '0') + '  /  ' + String(total).padStart(2, '0'), { size: 900, color: '92A0AF', align: 'r', after: 0 })]));
    return slideXml(bg, c);
}
function contentSlide(s, slideNo, total) {
    const bg = slideNo % 2 ? '101827' : '0D1623';
    const c = [shape(2, 'Top accent', 0, 0, 13.333, 0.07, 'D4AF37')];
    c.push(textBox(3, 'Section', 0.78, 0.48, 9.2, 0.32, [para((s.eyebrow || 'INSIGHT').toUpperCase(), { size: 950, color: 'D4AF37', bold: true, after: 0 })]));
    c.push(textBox(4, 'Title', 0.76, 0.9, 11.7, 0.86, [para(s.title, { size: 2550, color: 'F7F5EF', bold: true, after: 0 })]));
    if (s.subtitle) c.push(textBox(5, 'Subtitle', 0.8, 1.75, 11.3, 0.55, [para(s.subtitle, { size: 1300, color: 'BAC5D1', after: 0 })]));
    let id = 10;
    const bodyY = s.subtitle ? 2.48 : 2.08;
    if (s.layout === 'quote' && s.quote) {
        c.push(shape(id++, 'Quote panel', 0.8, bodyY, 11.7, 3.35, '1A2A3B', 'roundRect'));
        c.push(shape(id++, 'Quote accent', 1.12, bodyY + 0.46, 0.07, 2.25, 'D4AF37', 'roundRect'));
        c.push(textBox(id++, 'Quote', 1.48, bodyY + 0.56, 10.1, 1.95, [para('“' + s.quote + '”', { size: 2250, color: 'F7F5EF', bold: true, after: 0 })]));
        if (s.attribution) c.push(textBox(id++, 'Attribution', 1.52, bodyY + 2.55, 9.8, 0.46, [para('— ' + s.attribution, { size: 1200, color: 'D4AF37', after: 0 })]));
    } else if (s.layout === 'compare') {
        const cols = [{ x: 0.82, title: s.leftTitle || 'Perspective A', bullets: s.leftBullets }, { x: 6.83, title: s.rightTitle || 'Perspective B', bullets: s.rightBullets }];
        cols.forEach((col, ci) => {
            c.push(shape(id++, 'Comparison card ' + ci, col.x, bodyY, 5.68, 3.72, ci ? '1B2D40' : '1A2738', 'roundRect'));
            c.push(textBox(id++, 'Comparison heading ' + ci, col.x + 0.32, bodyY + 0.26, 5.0, 0.52, [para(col.title, { size: 1450, color: ci ? '63C7B2' : 'D4AF37', bold: true, after: 0 })]));
            const bullets = col.bullets.length ? col.bullets : (ci ? s.bullets.slice(Math.ceil(s.bullets.length / 2)) : s.bullets.slice(0, Math.ceil(s.bullets.length / 2)));
            const ps = bullets.map((b) => para('•  ' + b, { size: 1250, color: 'E9EDF1', after: 850 }));
            if (ps.length) c.push(textBox(id++, 'Comparison points ' + ci, col.x + 0.34, bodyY + 0.95, 5.0, 2.45, ps));
        });
    } else if (s.layout === 'stat' && s.stat) {
        c.push(shape(id++, 'Statistic card', 0.82, bodyY, 5.0, 3.5, '1A2A3B', 'roundRect'));
        c.push(textBox(id++, 'Statistic', 1.1, bodyY + 0.58, 4.45, 1.3, [para(s.stat, { size: 3300, color: 'D4AF37', bold: true, after: 0 })]));
        if (s.subtitle || s.body) c.push(textBox(id++, 'Statistic description', 1.16, bodyY + 2.1, 4.3, 0.9, [para(s.body || s.subtitle, { size: 1250, color: 'E2E7EC', after: 0 })]));
        const bullets = s.bullets.slice(0, 4);
        if (bullets.length) c.push(textBox(id++, 'Statistic context', 6.2, bodyY + 0.1, 6.0, 3.2, bullets.map((b) => para('•  ' + b, { size: 1375, color: 'E9EDF1', after: 1050 })));
    } else {
        const bullets = s.bullets.slice(0, 6);
        const twoCols = bullets.length > 4;
        if (s.body) {
            c.push(shape(id++, 'Content body panel', 0.82, bodyY, 11.65, s.visual ? 2.5 : 3.45, '18283A', 'roundRect'));
            c.push(textBox(id++, 'Body copy', 1.14, bodyY + 0.34, 10.95, s.visual ? 1.8 : 2.75, [para(s.body, { size: 1500, color: 'E9EDF1', after: 0 })]));
        }
        if (bullets.length) {
            const top = s.body ? bodyY + 2.9 : bodyY + 0.18;
            const per = twoCols ? Math.ceil(bullets.length / 2) : bullets.length;
            [0, twoCols ? 1 : 0].forEach((col) => {
                const chosen = twoCols ? bullets.slice(col * per, (col + 1) * per) : bullets;
                if (!chosen.length) return;
                const x = twoCols ? (col ? 6.75 : 0.84) : 0.9;
                c.push(textBox(id++, 'Key points ' + col, x, top, twoCols ? 5.7 : 11.2, Math.max(1.45, 3.05 - (top - bodyY)), chosen.map((b) => para('•  ' + b, { size: twoCols ? 1150 : 1300, color: 'E9EDF1', after: twoCols ? 650 : 780 }))));
            });
        }
        if (s.visual) {
            c.push(shape(id++, 'Visual focus card', 0.82, 5.7, 11.65, 0.63, '21364A', 'roundRect'));
            c.push(textBox(id++, 'Visual cue', 1.06, 5.83, 11.12, 0.34, [para('VISUAL  ·  ' + s.visual, { size: 850, color: '9EB3C7', after: 0 })]));
        }
    }
    c.push(shape(id++, 'Footer divider', 0.8, 6.72, 11.65, 0.018, '344457'));
    c.push(textBox(id++, 'Brand footer', 0.8, 6.88, 6.4, 0.25, [para('GOLDENSPACEAI  ·  ' + String(s.eyebrow || 'IDEAS, MADE CLEAR').toUpperCase(), { size: 800, color: '92A0AF', after: 0 })]));
    c.push(textBox(id++, 'Page number', 10.7, 6.86, 1.7, 0.28, [para(String(slideNo).padStart(2, '0') + '  /  ' + String(total).padStart(2, '0'), { size: 900, color: 'D4AF37', align: 'r', after: 0 })]));
    return slideXml(bg, c);
}
function slideXml(bg, shapes) {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="' + bg + '"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>' +
        groupTree(shapes) + '</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
}
function powerpointXml(data) {
    const zip = new JSZip();
    const count = data.slides.length;
    const ids = data.slides.map((_, i) => '<p:sldId id="' + (256 + i) + '" r:id="rId' + (i + 2) + '"/>').join('');
    zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' + data.slides.map((_, i) => '<Override PartName="/ppt/slides/slide' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>').join('') + '</Types>');
    zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>');
    zip.file('ppt/presentation.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>' + ids + '</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>');
    zip.file('ppt/_rels/presentation.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>' + data.slides.map((_, i) => '<Relationship Id="rId' + (i + 2) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide' + (i + 1) + '.xml"/>').join('') + '</Relationships>');
    const grp = groupTree([]);
    zip.file('ppt/slideMasters/slideMaster1.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="GoldenSpaceAI Master">' + grp + '</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="3200" b="1"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr marL="0" indent="0"><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:otherStyle></p:txStyles></p:sldMaster>');
    zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>');
    zip.file('ppt/slideLayouts/slideLayout1.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Blank">' + grp + '</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>');
    zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>');
    zip.file('ppt/theme/theme1.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="GoldenSpaceAI"><a:themeElements><a:clrScheme name="GoldenSpaceAI"><a:dk1><a:srgbClr val="101827"/></a:dk1><a:lt1><a:srgbClr val="F7F5EF"/></a:lt1><a:dk2><a:srgbClr val="0D1623"/></a:dk2><a:lt2><a:srgbClr val="E9EDF1"/></a:lt2><a:accent1><a:srgbClr val="D4AF37"/></a:accent1><a:accent2><a:srgbClr val="63C7B2"/></a:accent2><a:accent3><a:srgbClr val="8AB4F8"/></a:accent3><a:accent4><a:srgbClr val="E39B83"/></a:accent4><a:accent5><a:srgbClr val="A88BE8"/></a:accent5><a:accent6><a:srgbClr val="C7D0DB"/></a:accent6><a:hlink><a:srgbClr val="8AB4F8"/></a:hlink><a:folHlink><a:srgbClr val="A88BE8"/></a:folHlink></a:clrScheme><a:fontScheme name="GoldenSpaceAI"><a:majorFont><a:latin typeface="Aptos Display"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="GoldenSpaceAI"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:lumMod val="80000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:lumMod val="60000"/></a:schemeClr></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:lumMod val="95000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:lumMod val="90000"/></a:schemeClr></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>');
    data.slides.forEach((s, i) => {
        const xml = i === 0 ? coverSlide(Object.assign({}, s, { title: data.title || s.title, subtitle: data.subtitle || s.subtitle }), i + 1, count, false)
            : (i === count - 1 && s.layout === 'closing' ? coverSlide(s, i + 1, count, true) : contentSlide(s, i + 1, count));
        zip.file('ppt/slides/slide' + (i + 1) + '.xml', xml);
        zip.file('ppt/slides/_rels/slide' + (i + 1) + '.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>');
    });
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function wordParagraph(text, opts) {
    opts = opts || {};
    const style = opts.style ? '<w:pStyle w:val="' + opts.style + '"/>' : '';
    const color = hex(opts.color, '263347');
    const size = Math.max(18, Math.min(64, Number(opts.size) || 22));
    const bold = opts.bold ? '<w:b/>' : '';
    const italic = opts.italic ? '<w:i/>' : '';
    const pPr = style + (opts.shading ? '<w:shd w:fill="' + hex(opts.shading) + '" w:val="clear"/>' : '') + (opts.indent ? '<w:ind w:left="420" w:hanging="200"/>' : '') + (opts.after ? '<w:spacing w:after="' + opts.after + '"/>' : '');
    return '<w:p><w:pPr>' + pPr + '</w:pPr><w:r><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/><w:color w:val="' + color + '"/><w:sz w:val="' + size + '"/>' + bold + italic + '</w:rPr><w:t xml:space="preserve">' + esc(text) + '</w:t></w:r></w:p>';
}
function wordXml(data) {
    const parts = [];
    parts.push(wordParagraph('GOLDENSPACEAI  ·  FIELD NOTES', { color: 'A37A11', size: 20, bold: true, after: 240 }));
    parts.push(wordParagraph(data.title, { color: '172232', size: 52, bold: true, after: 280 }));
    if (data.subtitle) parts.push(wordParagraph(data.subtitle, { color: '617184', size: 26, after: 500 }));
    parts.push(wordParagraph('A clear, structured document prepared with GoldenSpaceAI.', { color: '8491A0', size: 20 }));
    parts.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    data.slides.slice(1).forEach((slide, i) => {
        parts.push(wordParagraph(String(i + 1).padStart(2, '0') + '  ·  ' + (slide.eyebrow || 'SECTION').toUpperCase(), { color: 'A37A11', size: 18, bold: true, after: 100 }));
        parts.push(wordParagraph(slide.title, { style: 'Heading1', color: '172232', size: 34, bold: true, after: 180 }));
        if (slide.subtitle) parts.push(wordParagraph(slide.subtitle, { color: '617184', size: 22, italic: true, after: 200 }));
        if (slide.body) parts.push(wordParagraph(slide.body, { color: '263347', size: 22, after: 220 }));
        if (slide.stat) parts.push(wordParagraph(slide.stat, { color: 'A37A11', size: 38, bold: true, shading: 'F7F1E0', after: 240 }));
        if (slide.quote) {
            parts.push(wordParagraph('“' + slide.quote + '”', { color: '33465B', size: 28, italic: true, shading: 'EEF2F6', after: 200 }));
            if (slide.attribution) parts.push(wordParagraph('— ' + slide.attribution, { color: 'A37A11', size: 20, bold: true, after: 180 }));
        }
        slide.bullets.concat(slide.leftBullets, slide.rightBullets).forEach((bullet) => parts.push(wordParagraph('•  ' + bullet, { color: '263347', size: 22, indent: true, after: 100 })));
        if (slide.leftTitle || slide.rightTitle) {
            if (slide.leftTitle) parts.push(wordParagraph(slide.leftTitle + ': ' + slide.leftBullets.join(' · '), { color: '3D5065', size: 21, after: 130 }));
            if (slide.rightTitle) parts.push(wordParagraph(slide.rightTitle + ': ' + slide.rightBullets.join(' · '), { color: '3D5065', size: 21, after: 130 }));
        }
        if (slide.visual) parts.push(wordParagraph('Visual direction: ' + slide.visual, { color: '748496', size: 18, italic: true, after: 260 }));
    });
    const doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + parts.join('') + '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="540" w:footer="540" w:gutter="0"/></w:sectPr></w:body></w:document>';
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', doc);
    zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
    zip.file('word/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:rFonts w:ascii="Aptos Display" w:hAnsi="Aptos Display"/><w:color w:val="172232"/><w:b/><w:sz w:val="52"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="260" w:after="140"/></w:pPr><w:rPr><w:rFonts w:ascii="Aptos Display" w:hAnsi="Aptos Display"/><w:color w:val="172232"/><w:b/><w:sz w:val="34"/></w:rPr></w:style></w:styles>');
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function createOfficeDocument(artifact, format) {
    const data = normalizeArtifact(artifact);
    if (format === 'pptx') return powerpointXml(data);
    if (format === 'docx') return wordXml(data);
    throw new Error('Choose PowerPoint or Word format.');
}
module.exports = { createOfficeDocument };
