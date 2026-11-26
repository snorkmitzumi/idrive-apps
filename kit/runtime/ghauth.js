'use strict';
/**
 * ghauth.js - the log upload's sign-in from a phone, with no file to put on the head unit: GitHub's device flow for a
 * GitHub App. The car shows a code (and a QR code of github.com/login/device); the owner opens that page on a phone,
 * types the code and allows it; the app then has a token of its own, limited to what both the GitHub App and the owner
 * can reach: the repositories the owner installed the app on (Contents: read and write, nothing else).
 *
 * Tokens: the access token lasts 8 hours and is renewed with the refresh token (6 months, a new one at each renewal);
 * a device-flow app renews with its client id alone, so no secret is in the app. An app whose GitHub App has token
 * expiry switched off gets one token that does not expire. Kept in the data folder (upload-auth.json, mode 600); never
 * logged or shown.
 *
 * The repository: the one the GitHub App is installed on (several: the one whose name ends in "logs", else the first).
 *
 *   const a = new GitHubAuth({ file, clientId, log, http })   http(req) -> Promise<{ status, text }> (logupload.js:
 *                                                              over the uplink's DNS)
 *   a.start()          the device flow: a.flow = { phase: 'asking' | 'code' | 'done' | 'error', code, uri, until, message }
 *   a.cancel()         stops waiting for the phone
 *   a.signedIn()       { login, repo } or null
 *   await a.token()    a usable access token (renewed when due), or null: signed out
 *   a.signOut()        forgets the tokens (the owner can also revoke the app on GitHub)
 *   signInSheet(...)   the settings sheet for it (sheet.js)
 */
const fs = require('fs');
const qr = require('./qr');
const { pill, TOP } = require('./sheet');

const DEVICE_URI = 'https://github.com/login/device';
const RENEW_MS = 5 * 60 * 1000;          // an access token this close to its end is renewed first

const form = (o) => Object.keys(o).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(o[k])).join('&');
const parse = (r) => { try { return JSON.parse(r.text); } catch (e) { return {}; } };

class GitHubAuth {
    constructor(o) {
        this.file = o.file; this.clientId = o.clientId; this.log = o.log; this.http = o.http;
        this.now = o.now || (() => Date.now());
        this.wait = o.wait || ((ms, fn) => setTimeout(fn, ms));
        this.flow = null;
        this.a = this.load();
    }

    load() { try { const a = JSON.parse(fs.readFileSync(this.file, 'utf8')); return a && (a.access || a.refresh) ? a : null; } catch (e) { return null; } }

    save(a) {
        this.a = a;
        try { fs.writeFileSync(this.file + '.tmp', JSON.stringify(a), { mode: 0o600 }); fs.renameSync(this.file + '.tmp', this.file); } catch (e) { this.log.warn('sign-in: could not save the tokens: ' + (e && e.code || e)); }
    }

    signedIn() { return this.a && this.a.repo ? { login: this.a.login || '', repo: this.a.repo } : null; }

    signOut() {
        this.cancel();
        this.a = null;
        try { fs.unlinkSync(this.file); } catch (e) { /* none */ }
        this.log.info('log upload: signed out of GitHub');
    }

    /** github.com's sign-in endpoints: a form in, JSON back. */
    post(path, params) {
        return this.http({ method: 'POST', host: 'github.com', path, headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(params) }).then(parse);
    }

    api(path, token) {
        return this.http({ method: 'GET', host: 'api.github.com', path, headers: { 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + token } })
            .then((r) => { if (r.status !== 200) throw new Error('GitHub ' + r.status + ' for ' + path.split('?')[0]); return parse(r); });
    }

    /** The token answer (first one or a renewal) as kept: when each token ends (null: never). */
    keep(t, extra) {
        const now = this.now();
        return Object.assign({}, this.a || {}, extra || {}, {
            access: t.access_token, accessEnd: t.expires_in ? now + t.expires_in * 1000 : null,
            refresh: t.refresh_token || null, refreshEnd: t.refresh_token_expires_in ? now + t.refresh_token_expires_in * 1000 : null,
        });
    }

    start() {
        if (!this.clientId) { this.flow = { phase: 'error', message: 'This app has no GitHub App for sign-in (app.json logUpload.clientId)' }; return; }
        this.cancel();
        const flow = this.flow = { phase: 'asking' };
        this.post('/login/device/code', { client_id: this.clientId }).then((d) => {
            if (this.flow !== flow) return;
            if (!d.device_code || !d.user_code) throw new Error(d.error_description || d.error || 'no code from GitHub');
            Object.assign(flow, { phase: 'code', code: d.user_code, uri: d.verification_uri || DEVICE_URI, until: this.now() + (d.expires_in || 900) * 1000,
                device: d.device_code, every: (d.interval || 5) * 1000 });
            this.log.info('log upload: sign-in code shown, waiting for the phone');
            this.poll(flow);
        }).catch((e) => this.fail(flow, e));
    }

    poll(flow) {
        flow.timer = this.wait(flow.every, () => {
            if (this.flow !== flow) return;
            if (this.now() > flow.until) { this.fail(flow, new Error('The code expired: sign in again')); return; }
            this.post('/login/oauth/access_token', { client_id: this.clientId, device_code: flow.device, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }).then((t) => {
                if (this.flow !== flow) return null;
                if (t.access_token) return this.finish(flow, t);
                if (t.error === 'authorization_pending') return this.poll(flow);
                if (t.error === 'slow_down') { flow.every = (t.interval ? t.interval * 1000 : flow.every + 5000); return this.poll(flow); }
                if (t.error === 'access_denied') throw new Error('Not allowed on the phone');
                if (t.error === 'expired_token' || t.error === 'token_expired') throw new Error('The code expired: sign in again');
                throw new Error(t.error_description || t.error || 'no token from GitHub');
            }).catch((e) => {
                // a lost connection while waiting: try again at the next turn
                if (this.flow === flow && e && (e.code || /internet/.test(e.message))) return this.poll(flow);
                return this.fail(flow, e);
            });
        });
    }

    /** Signed in: who, and which repository the GitHub App may write to. */
    finish(flow, t) {
        const token = t.access_token;
        return Promise.all([this.api('/user', token), this.api('/user/installations?per_page=100', token)]).then(([user, inst]) => {
            const ids = (inst.installations || []).map((i) => i.id);
            return Promise.all(ids.map((id) => this.api('/user/installations/' + id + '/repositories?per_page=100', token)))
                .then((lists) => ({ login: user.login || '', repos: [].concat.apply([], lists.map((l) => (l.repositories || []).map((r) => r.full_name))) }));
        }).then(({ login, repos }) => {
            if (this.flow !== flow) return;
            if (!repos.length) throw new Error('Signed in as ' + login + ', but the GitHub App is on no repository: install it on your logs repository, then sign in again');
            const repo = repos.filter((r) => /logs?$/i.test(r))[0] || repos[0];
            this.save(this.keep(t, { login, repo }));
            flow.phase = 'done'; flow.login = login; flow.repo = repo;
            this.log.info('log upload: signed in to GitHub, uploading to ' + repo + (repos.length > 1 ? ' (of ' + repos.length + ')' : ''));
            if (this.onSignedIn) this.onSignedIn();
        }).catch((e) => this.fail(flow, e));
    }

    fail(flow, e) {
        if (this.flow !== flow) return;
        flow.phase = 'error';
        flow.message = (e && e.message) || String(e);
        this.log.warn('log upload: sign-in: ' + flow.message);
    }

    cancel() { const f = this.flow; this.flow = null; if (f && f.timer) clearTimeout(f.timer); }

    /** A usable access token: renewed when it ends within RENEW_MS; null when signed out or the renewal was refused. */
    async token() {
        const a = this.a;
        if (!a) return null;
        const now = this.now();
        if (a.access && (!a.accessEnd || a.accessEnd - now > RENEW_MS)) return a.access;
        if (!a.refresh || (a.refreshEnd && a.refreshEnd <= now)) { this.log.warn('log upload: the GitHub sign-in ran out (6 months): sign in again'); this.signOut(); return null; }
        const t = await this.post('/login/oauth/access_token', { client_id: this.clientId, grant_type: 'refresh_token', refresh_token: a.refresh });
        if (!t.access_token) {
            if (t.error === 'bad_refresh_token' || t.error === 'incorrect_client_credentials') { this.log.warn('log upload: GitHub no longer takes the sign-in (' + t.error + '): sign in again'); this.signOut(); return null; }
            throw new Error('renewing the GitHub token: ' + (t.error || 'no answer'));
        }
        this.save(this.keep(t));
        return t.access_token;
    }
}

/* ---------------- the sheet ---------------- */

/** A QR code drawn black on white in a box (side page px), each module whole screen pixels (as the QR log). */
function drawQr(r, q, x, y, box) {
    const sc = r.textScale || 1, n = q.size + 8, dev = Math.max(1, Math.floor(box * sc / n)), side = dev * n / sc;
    const ox = Math.round((x + (box - side) / 2) * sc), oy = Math.round((y + (box - side) / 2) * sc);
    const at = (o, k) => (o + k * dev) / sc;
    r.fillRect(at(ox, 0), at(oy, 0), side, side, '#ffffff');
    for (let yy = 0; yy < q.size; yy++) {
        for (let xx = 0; xx < q.size;) {
            if (!q.get(xx, yy)) { xx++; continue; }
            let e = xx;
            while (e < q.size && q.get(e, yy)) e++;
            r.fillRect(at(ox, xx + 4), at(oy, yy + 4), (e - xx) * dev / sc, dev / sc, '#000000');
            xx = e;
        }
    }
}

/**
 * Settings > Log upload when the app has a GitHub App for sign-in. opts: { auth (GitHubAuth), send(why) (the upload),
 * status() (the row's text), enabled(), enable() (switches Upload logs on: signing in is the owner asking for it) }
 */
function signInSheet(opts) {
    const { auth } = opts;
    const st = { focus: 0, qr: null, sent: null };
    auth.onSignedIn = () => { if (!opts.enabled()) opts.enable(); };
    const buttons = () => {
        const f = auth.flow, me = auth.signedIn();
        if (f && (f.phase === 'asking' || f.phase === 'code')) return [{ label: 'Cancel', run: () => { auth.cancel(); return null; } }, { label: 'Back', run: () => { auth.cancel(); return 'close'; } }];
        if (me) {
            return [
                { label: 'Send now', run: () => { st.sent = 'Sending...'; Promise.resolve(opts.send('by hand')).then((r) => { st.sent = r === 'sent' ? 'Sent.' : r === 'nothing' ? 'Nothing new to send.' : r === 'offline' ? 'No internet (mgu-uplink).' : r === 'off' ? 'Upload logs is off in Settings.' : 'Not sent: see the log.'; }); return null; } },
                { label: 'Sign out', run: () => { auth.signOut(); st.sent = null; st.focus = 0; return null; } },
                { label: 'Back', run: () => 'close' },
            ];
        }
        return [{ label: f && f.phase === 'error' ? 'Try again' : 'Sign in with GitHub', run: () => { auth.start(); st.focus = 0; return null; } }, { label: 'Back', run: () => 'close' }];
    };
    return {
        title: 'Log upload',
        draw(r, t) {
            r.clear(t.bg);
            const targets = [], f = auth.flow, me = auth.signedIn(), bottom = 512 + (r.extra || 0) - 6;
            const showCode = f && f.phase === 'code';
            const box = bottom - (TOP + 4), x0 = 40, tx = showCode ? x0 + box + 50 : x0 + 20, tw = 1600 - 40 - tx;
            if (showCode) {
                if (!st.qr || st.qr.uri !== f.uri) st.qr = { uri: f.uri, q: qr.encode(Buffer.from(f.uri, 'utf8'), { ecl: 'M' }) };
                drawQr(r, st.qr.q, x0, TOP + 4, box);
            }
            // (y: the top of the next line; each line goes down by its own size, the big code too)
            let y = TOP + 14;
            const line = (s, size, color, font) => { y += size; r.text(s, tx, y, size, color, font ? { font } : undefined); y += Math.round(size * 0.45); };
            line('Log upload: sign in with GitHub', 34, t.text, 'bold');
            y += 6;
            if (showCode) {
                line('On your phone, scan the code or open', 24, t.dim);
                line(f.uri.replace(/^https:\/\//, ''), 30, t.text, 'bold');
                line('and type this code:', 24, t.dim);
                y += 10;
                line(f.code, 64, t.accent, 'bold');
                line('Allow it, then this page goes on by itself (' + Math.max(0, Math.ceil((f.until - Date.now()) / 60000)) + ' min left).', 22, t.dim);
            } else if (f && f.phase === 'asking') {
                line('Asking GitHub for a code...', 26, t.text);
            } else if (me) {
                line('Signed in as ' + me.login + '.', 26, t.text);
                line('The log goes to ' + me.repo + ' as the car stops, after a start,', 24, t.dim);
                line('and when you press Send now. ' + (opts.enabled() ? '' : 'Upload logs is off in Settings.'), 24, t.dim);
                if (st.sent) line(st.sent, 24, t.text);
            } else {
                if (f && f.phase === 'error') line(f.message, 24, t.warn || t.text);
                line('Sends this app\'s log to a GitHub repository of yours, with no file to copy to the car.', 24, t.dim);
                line('Once: install the GitHub App on your (private) logs repository.', 24, t.dim);
                line('Then sign in here: the car shows a code to type on your phone.', 24, t.dim);
                line('The app can write to that repository only. Needs internet (mgu-uplink).', 24, t.dim);
            }
            const bs = buttons(), bw = Math.min(360, Math.floor((tw - 16 * (bs.length - 1)) / bs.length)), by = Math.min(bottom - 60, Math.max(y + 10, TOP + 330));
            st.focus = Math.min(st.focus, bs.length - 1);
            bs.forEach((b, i) => {
                const x = tx + i * (bw + 16);
                pill(r, t, x, by, bw, 50, b.label, i === st.focus);
                targets.push({ x, y: by - 6, w: bw, h: 62, act: () => { st.focus = i; return b.run(); } });
            });
            return targets;
        },
        move(d) { st.focus = Math.max(0, Math.min(buttons().length - 1, st.focus + (d > 0 ? 1 : -1))); },
        press() { return buttons()[Math.min(st.focus, buttons().length - 1)].run(); },
        back() { auth.cancel(); return 'close'; },
        top() { return st.focus === 0; },
    };
}

module.exports = { GitHubAuth, signInSheet, DEVICE_URI };
