#!/usr/bin/env node
'use strict';
/*
 * Read-only: prints the HMI's page templates (bmw/widget/*.pbw) in readable form, the numbers turned back into
 * names with this head unit's own HmiMain3D (hmi_template.js identifiers()). For the full-screen template work:
 * how BMW's own full-screen pages (the map, the camera, video) place another program's surface with no title bar.
 * Writes nothing but the output file; copies no BMW file anywhere.
 *
 *   node pbw_dump.js [--out /tmp/pbw-dump.txt] [--all] [NAME_PART ...]
 *     default: every template that holds an embedded surface or a map, video or camera widget, every one named
 *     like a map, navigation, video, camera or full-screen page, and mgu-render's own (LT_State_A4A_WelcomeApp);
 *     --all: every template's name only, as a list;
 *     NAME_PART: the templates whose file name contains it, dumped whole.
 */
const fs = require('fs');
const path = require('path');
const { identifiers } = require('./hmi_template.js');

const WIDGETS = '/mnt/dataro/data/hmi/bmw/widget';
const HMI = '/usr/bin/HmiMain3D';
const MAX_LINES = 4000;

const args = process.argv.slice(2);
const opt = { out: '/tmp/pbw-dump.txt', all: false, parts: [] };
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') opt.out = args[++i];
    else if (args[i] === '--all') opt.all = true;
    else opt.parts.push(args[i]);
}

const ids = identifiers(fs.readFileSync(HMI));
const names = new Map();
ids.forEach((n, name) => names.set(n, name));
const short = (s) => s.replace(/^eGfxId(WidgetType_|Widget_|Parameter_|ParameterValue_|Layout_|ImportDefinition_)?/, '');

/* protobuf, field by field: { f, wt, v (number) | b (Buffer) } */
function varint(b, o) {
    let x = 0, mul = 1, i = o;
    for (; i < b.length; i++) {
        x += (b[i] & 0x7f) * mul;
        mul *= 128;
        if (!(b[i] & 0x80)) return [x, i + 1];
        if (i - o > 9) return null;
    }
    return null;
}
function fields(b) {
    const out = [];
    let o = 0;
    while (o < b.length) {
        const k = varint(b, o);
        if (!k) return null;
        const f = Math.floor(k[0] / 8), wt = k[0] % 8;
        o = k[1];
        if (f === 0) return null;
        if (wt === 0) { const v = varint(b, o); if (!v) return null; out.push({ f, wt, v: v[0] }); o = v[1]; }
        else if (wt === 2) { const n = varint(b, o); if (!n || n[1] + n[0] > b.length) return null; out.push({ f, wt, b: b.slice(n[1], n[1] + n[0]) }); o = n[1] + n[0]; }
        else if (wt === 5) { if (o + 4 > b.length) return null; out.push({ f, wt, b: b.slice(o, o + 4) }); o += 4; }
        else if (wt === 1) { if (o + 8 > b.length) return null; out.push({ f, wt, b: b.slice(o, o + 8) }); o += 8; }
        else return null;
    }
    return out;
}
/* an identifier: a message holding only field 1 = a known number */
function asName(b) {
    const fs1 = fields(b);
    return fs1 && fs1.length === 1 && fs1[0].f === 1 && fs1[0].wt === 0 && names.has(fs1[0].v) ? names.get(fs1[0].v) : null;
}
function dump(b, depth, lines) {
    const fl = fields(b);
    const pad = '  '.repeat(depth);
    if (!fl) { lines.push(pad + 'bytes ' + b.toString('hex').slice(0, 80)); return; }
    for (const x of fl) {
        if (lines.length > MAX_LINES) return;
        if (x.wt === 0) lines.push(pad + x.f + ': ' + x.v + (names.has(x.v) && x.v > 20 ? '   (' + short(names.get(x.v)) + '?)' : ''));
        else if (x.wt === 5) lines.push(pad + x.f + ': f32 ' + Math.round(x.b.readFloatLE(0) * 1000) / 1000);
        else if (x.wt === 1) lines.push(pad + x.f + ': f64 ' + x.b.readDoubleLE(0));
        else {
            const nm = asName(x.b);
            if (nm) { lines.push(pad + x.f + ': ' + short(nm)); continue; }
            const sub = x.b.length ? fields(x.b) : [];
            if (sub && x.b.length) { lines.push(pad + x.f + ' {'); dump(x.b, depth + 1, lines); lines.push(pad + '}'); }
            else if (/^[\x20-\x7e]*$/.test(x.b.toString('latin1'))) lines.push(pad + x.f + ': "' + x.b.toString('latin1') + '"');
            else lines.push(pad + x.f + ': bytes ' + x.b.toString('hex').slice(0, 80));
        }
    }
}
/* every identifier name a template uses */
function namesIn(b, acc) {
    const fl = fields(b);
    if (!fl) return acc;
    for (const x of fl) {
        if (x.wt !== 2) continue;
        const nm = asName(x.b);
        if (nm) acc.add(nm); else namesIn(x.b, acc);
    }
    return acc;
}

const files = fs.readdirSync(WIDGETS).filter((f) => /\.pbw$/.test(f)).sort();
const out = ['# HMI page templates, ' + files.length + ' files in ' + WIDGETS + ', ' + ids.size + ' identifiers in ' + HMI, ''];
const want = (f, used) => (opt.parts.length ? opt.parts.some((p) => f.indexOf(p) >= 0)
    : /A4A_WelcomeApp|Map|Navi|Video|Camera|Cam_|Full/i.test(f) || Array.from(used).some((n) => /EmbeddedSurface|SurfaceId|eWidgetType_\w*(Map|Video|Camera)/i.test(n)));
let n = 0;
for (const f of files) {
    const b = fs.readFileSync(path.join(WIDGETS, f));
    const used = namesIn(b, new Set());
    if (opt.all) { out.push(f + '  ' + b.length + ' bytes' + (Array.from(used).some((x) => /EmbeddedSurface/.test(x)) ? '  [embedded surface]' : '')); continue; }
    if (!want(f, used)) continue;
    n++;
    out.push('==== ' + f + ' (' + b.length + ' bytes)');
    const lines = [];
    dump(b, 0, lines);
    out.push.apply(out, lines.slice(0, MAX_LINES));
    out.push('');
}
if (!opt.all) out.splice(1, 0, '# ' + n + ' templates dumped');
fs.writeFileSync(opt.out, out.join('\n') + '\n');
console.log((opt.all ? files.length + ' templates listed' : n + ' templates dumped') + ' to ' + opt.out + ' (' + fs.statSync(opt.out).size + ' bytes)');
