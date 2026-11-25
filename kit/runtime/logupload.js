'use strict';
/**
 * logupload.js - the app's log sent to a GitHub repository of the owner's, when the app asks (Cockpit: as the car
 * stops), for an app whose owner switched it on. Nothing is sent unless the app's setting is on AND the app's data
 * folder holds upload.json, which only someone with SSH puts there:
 *
 *   { "repo": "owner/name", "token": "github_pat_...", "branch": "main", "dir": "logs" }   (branch, dir optional)
 *
 * The token: a fine-grained one for that repository alone, "Contents: read and write". A private repository: the log
 * names the car's state, odometer and times. The token is never logged or shown.
 *
 * The head unit's apps reach the internet through the MGU Store's mgu-uplink (a USB modem, a tethered phone, Wi-Fi):
 * its lease (data/uplink.json, else /run/mgu-uplink/lease.json) names the DNS servers to ask, as the unit's own resolver
 * does not reach out. No lease: offline, the lines wait for the next try.
 *
 * Each upload is one new file, <dir>/<app>/<YYYY-MM>/<first line's time>-<version>.log, of the lines since the last one
 * sent (upload-state.json keeps that line's time), with a VIN masked as the QR log does.
 *
 *   const up = new LogUpload({ file, dataDir, app, version, log, enabled: () => bool })
 *   up.send(why)     a try now (a Promise: 'sent' | 'off' | 'nothing' | 'no config' | 'offline' | 'failed' | 'busy')
 *   up.status()      one line for the settings row
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const dns = require('dns');

const LEASES = ['/run/mgu-uplink/lease.json'];
const TIMEOUT_MS = 30000, MAX_BYTES = 900 * 1024;
const TS = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z) /;

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }

/** The log's lines newer than `after` (an ISO time, '' = all), the rotated file's first. Lines without a time (a stack's)
 *  go with the line before. */
function newLines(file, after) {
    const out = [];
    let keep = false;
    [file + '.1', file].forEach((f) => {
        let text = '';
        try { text = fs.readFileSync(f, 'utf8'); } catch (e) { return; }
        text.split('\n').forEach((l) => {
            if (!l) return;
            const m = TS.exec(l);
            if (m) keep = m[1] > after;
            if (keep) out.push(l);
        });
    });
    return out;
}

/** The newest lines that fit in max bytes (the start of a long backlog left out). */
function fit(lines, max) {
    let n = 0, i = lines.length;
    while (i > 0 && n + Buffer.byteLength(lines[i - 1]) + 1 <= max) n += Buffer.byteLength(lines[--i]) + 1;
    return lines.slice(i);
}

function mask(text) { return text.replace(/\b[A-HJ-NPR-Z0-9]{17}\b/g, '<VIN>'); }

/** dns.lookup's shape over the lease's DNS servers (none: the unit's resolver). */
function lookupVia(servers) {
    if (!servers || !servers.length || !dns.Resolver) return undefined;
    const r = new dns.Resolver();
    try { r.setServers(servers); } catch (e) { return undefined; }
    return (host, opts, cb) => {
        if (typeof opts === 'function') { cb = opts; opts = {}; }
        // (a newer Node asks for every address: opts.all; the car's Node 8 for one)
        r.resolve4(host, (e, a) => (e || !a || !a.length ? cb(e || new Error('no address for ' + host))
            : opts && opts.all ? cb(null, a.map((x) => ({ address: x, family: 4 }))) : cb(null, a[0], 4)));
    };
}

/** PUT a file through GitHub's contents API: resolves the HTTP status, rejects on a network error. */
function put(cfg, file, body, lookup) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = https.request({
            host: 'api.github.com', method: 'PUT', lookup,
            path: '/repos/' + cfg.repo + '/contents/' + file.split('/').map(encodeURIComponent).join('/'),
            headers: {
                'Authorization': 'Bearer ' + cfg.token, 'User-Agent': 'mgu-app-log-upload', 'Accept': 'application/vnd.github+json',
                'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
            },
        }, (res) => {
            let txt = '';
            res.on('data', (d) => { if (txt.length < 2000) txt += d; });
            res.on('end', () => resolve({ status: res.statusCode, text: txt }));
        });
        req.setTimeout(TIMEOUT_MS, () => req.abort());
        req.on('error', reject);
        req.end(data);
    });
}

class LogUpload {
    constructor(o) {
        this.file = o.file; this.dataDir = o.dataDir; this.app = o.app; this.version = o.version;
        this.log = o.log; this.enabled = o.enabled || (() => false);
        this.put = o.put || put;                       // (tests)
        this.leases = o.leases || LEASES;
        this.stateFile = path.join(this.dataDir, 'upload-state.json');
        this.busy = false;
        this.last = null;                              // { at, what }
        const st = readJson(this.stateFile) || {};
        this.sent = typeof st.sent === 'string' ? st.sent : null;
        this.sentAt = st.sentAt || null;
    }

    config() {
        const c = readJson(path.join(this.dataDir, 'upload.json'));
        if (!c || typeof c.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(c.repo) || typeof c.token !== 'string' || !c.token) return null;
        return { repo: c.repo, token: c.token, branch: typeof c.branch === 'string' ? c.branch : null, dir: typeof c.dir === 'string' ? c.dir.replace(/^\/+|\/+$/g, '') : 'logs' };
    }

    lease() {
        for (const f of [path.join(this.dataDir, 'uplink.json')].concat(this.leases)) {
            const l = readJson(f);
            if (l && Array.isArray(l.dns)) return l;
        }
        return null;
    }

    note(what) { this.last = { at: Date.now(), what }; return what; }

    async send(why) {
        if (!this.enabled()) return 'off';
        if (this.busy) return 'busy';
        const cfg = this.config();
        if (!cfg) { if (!this.last || this.last.what !== 'no config') this.log.warn('log upload: no upload.json (repo and token) in ' + this.dataDir); return this.note('no config'); }
        const lease = this.lease();
        if (!lease) { if (!this.last || this.last.what !== 'offline') this.log.info('log upload (' + why + '): no internet (no mgu-uplink lease), later'); return this.note('offline'); }
        // (the first upload: all the log holds, 512 KB at most)
        const lines = fit(newLines(this.file, this.sent || ''), MAX_BYTES);
        if (!lines.length) return this.note('nothing');
        this.busy = true;
        try {
            const first = TS.exec(lines[0]), lastT = TS.exec(lines.filter((l) => TS.test(l)).pop() || '');
            const t0 = (first ? first[1] : new Date().toISOString()).replace(/\.\d+Z$/, '').replace(/:/g, '-');
            const file = (cfg.dir ? cfg.dir + '/' : '') + this.app + '/' + t0.slice(0, 7) + '/' + t0 + '-' + this.version + '.log';
            const body = { message: this.app + ' ' + this.version + ' log (' + why + ', ' + lines.length + ' lines)', content: Buffer.from(mask(lines.join('\n')) + '\n').toString('base64') };
            if (cfg.branch) body.branch = cfg.branch;
            const r = await this.put(cfg, file, body, lookupVia(lease.dns));
            if (r.status !== 201 && r.status !== 200) {
                this.log.warn('log upload: GitHub said ' + r.status + (r.status === 401 || r.status === 403 ? ' (the token: its repository and "Contents: read and write")' : r.status === 404 ? ' (no such repository for this token)' : '') + ' ' + String(r.text || '').slice(0, 120));
                return this.note('failed');
            }
            this.sent = lastT ? lastT[1] : new Date().toISOString();
            this.sentAt = Date.now();
            try { fs.writeFileSync(this.stateFile, JSON.stringify({ sent: this.sent, sentAt: this.sentAt })); } catch (e) { /* read-only (preview) */ }
            this.log.info('log upload (' + why + '): ' + lines.length + ' lines sent to ' + cfg.repo + ' ' + file);
            return this.note('sent');
        } catch (e) {
            this.log.warn('log upload (' + why + '): ' + (e && e.code || e && e.message || e) + ', later');
            return this.note('failed');
        } finally { this.busy = false; }
    }

    status() {
        if (!this.enabled()) return 'Off';
        if (!this.config()) return 'Needs upload.json in the app\'s data folder';
        const t = (ms) => { const d = new Date(ms); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); };
        const last = this.sentAt ? 'last sent ' + new Date(this.sentAt).toISOString().slice(0, 10) + ' ' + t(this.sentAt) : 'nothing sent yet';
        if (this.last && this.last.what === 'offline') return 'No internet (mgu-uplink): ' + last;
        if (this.last && this.last.what === 'failed') return 'Last try failed (see the log): ' + last;
        return 'On: ' + last + '. Press to send now';
    }
}

module.exports = { LogUpload, newLines, fit, mask, lookupVia };
