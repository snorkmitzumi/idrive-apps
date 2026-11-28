'use strict';
/**
 * Offline check of kit/runtime/profile.js: `kill -USR2 <pid>` records a CPU profile and writes it with a memory
 * report into the data folder; a second signal while one runs is ignored; only the newest KEEP of each stay.
 *
 *   node kit/tools/test_profile.js            (with --expose-gc too: the report's after-a-collection numbers)
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const profile = require(path.join(__dirname, '..', 'runtime', 'profile.js'));

const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'kit-profile-'));
const lines = [];
const log = { info: (m) => lines.push(m), warn: (m) => lines.push('WARN ' + m) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, check) => { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw new Error('timed out: ' + what); await sleep(20); } };
const files = (prefix) => fs.readdirSync(dir).filter((n) => n.indexOf(prefix) === 0).sort();

(async () => {
    // older reports than KEEP: pruned once a new one is written
    ['mem-20000101-000001.json', 'mem-20000101-000002.json', 'mem-20000101-000003.json', 'cpu-20000101-000001.cpuprofile',
        'cpu-20000101-000002.cpuprofile', 'cpu-20000101-000003.cpuprofile'].forEach((n) => fs.writeFileSync(path.join(dir, n), '{}'));
    profile.install({ dir, log, seconds: 0.4 });
    assert.deepStrictEqual(files('cpu-').length + files('mem-').length, 6, 'nothing written before the signal');
    // some work for the profile to see
    const busy = setInterval(() => { let x = 0; for (let i = 0; i < 2e5; i++) x += Math.sqrt(i); return x; }, 5);
    process.kill(process.pid, 'SIGUSR2');
    await sleep(50);
    process.kill(process.pid, 'SIGUSR2');          // while recording: ignored
    await until('the memory report', () => lines.some((l) => /memory report/.test(l)));
    clearInterval(busy);
    assert(lines.some((l) => /one is being recorded already/.test(l)), 'the second signal ignored: ' + lines.join(' | '));
    assert(!lines.some((l) => /^WARN/.test(l)), 'no warnings: ' + lines.join(' | '));
    const cpu = files('cpu-'), mem = files('mem-');
    assert.strictEqual(cpu.length, profile.KEEP, 'the newest ' + profile.KEEP + ' CPU profiles kept: ' + cpu.join(' '));
    assert.strictEqual(mem.length, profile.KEEP, 'the newest ' + profile.KEEP + ' memory reports kept: ' + mem.join(' '));
    assert(cpu.indexOf('cpu-20000101-000001.cpuprofile') < 0 && mem.indexOf('mem-20000101-000001.json') < 0, 'the oldest gone');
    const p = JSON.parse(fs.readFileSync(path.join(dir, cpu[cpu.length - 1]), 'utf8'));
    assert(Array.isArray(p.nodes) && p.nodes.length > 1 && Array.isArray(p.samples) && p.samples.length > 10, 'a CPU profile DevTools reads: ' + (p.nodes || []).length + ' nodes');
    const m = JSON.parse(fs.readFileSync(path.join(dir, mem[mem.length - 1]), 'utf8'));
    assert(m.beforeMB.rss > 0 && m.beforeMB.heapUsed > 0 && typeof m.beforeMB.external === 'number', 'memory before: ' + JSON.stringify(m.beforeMB));
    assert(typeof global.gc !== 'function' || (m.afterCollectionMB && m.afterCollectionMB.heapUsed > 0), 'after a collection (with --expose-gc)');
    assert(Array.isArray(m.spaces) && m.spaces.length > 2, 'V8\'s heap spaces');
    assert(fs.readdirSync(dir).every((n) => !/\.tmp$/.test(n)), 'no half-written file left');
    console.log('profile: ' + p.nodes.length + ' nodes, ' + p.samples.length + ' samples; all ok');
    process.exit(0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
