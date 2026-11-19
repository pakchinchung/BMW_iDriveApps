// SPDX-License-Identifier: MIT
// Copyright (c) 2026 h4m4d (Waze Cards, mgu-hamadstools); Maps on cluster integration 2026
'use strict';
/**
 * waze-cluster-cards - Waze's turn card and arrival card over the Waze map
 * Maps on cluster shows on the instrument cluster.
 *
 * Maps on cluster (waze-on-cluster) shows CarPlay's own cluster map, which
 * for Waze carries no turn card and no arrival time. This service grabs the
 * central screen with winston-grabber a few times a second, finds Waze's
 * cards there (card.js, from Waze Cards by h4m4d: Waze's full-screen map
 * and CarPlay's Dashboard), and draws them as two overlay images on
 * cluster-render's `map` target, in the same scene as the map, inside the
 * part of the map the gauges leave visible: the turn card at its top, the
 * arrival card at its bottom.
 *
 * The cards show only while waze-on-cluster's map is shown on the cluster
 * (cluster-render's status lists its video layer on `map` as shown), so
 * they never hold the map area on their own and never show over BMW's map.
 * Nothing is sent to CarPlay, the navigation or the HMI: it only reads the
 * screen and draws. Node 8, root (winston-grabber needs the compositor's
 * socket).
 *
 * The Maps on cluster app switches it on and off over the control socket
 * (SOCKET, root:tm_oap_app 0660), newline-delimited JSON:
 *   app -> service  {"cmd":"status"}
 *                   {"cmd":"cards","on":0|1}         saved in SETTINGS, at once
 *   service -> app  {"ev":"status","on":0|1,"state","view"}
 *                    state: "off" | "unavailable" (no cluster renderer) |
 *                    "waiting" (no Waze map on the cluster) | "looking"
 *                    (the map shows, Waze's cards are not on the central
 *                    screen) | "showing"; view: "full screen" | "Dashboard" | ""
 *                   {"ev":"cards-reply","ok":true|false,"reason"}
 *
 *   node cards.js [--once]      --once: one frame, print what was found, exit
 *
 * The timing and the cards' place can be changed in CONF_FILE (DEFAULTS).
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const card = require('./card');

const DIR = '/var/opt/waze-cluster-cards';
const DEFAULTS = {
    fps: 4,                         // frames grabbed a second while the cards show or were seen lately
    idleFps: 1,                     // ... and while no card has been seen for idleAfterMs
    idleAfterMs: 20000,
    showAfter: 2,                   // frames with the cards before they show
    hideAfter: 6,                   // frames without them before they hide (rides through Waze's animations)
    dropAfterMs: 10000,             // hidden this long: the layer is dropped
    mapPollMs: 1000,                // how often cluster-render is asked whether the map shows
    mapStaleMs: 3500,               // no answer for this long: the map counts as not shown
    mapProducer: 'waze-on-cluster', // the app name of the map's layer in cluster-render's status
    statusFile: '/run/cluster-render/status.txt',   // that status, written by cluster-render each second
    clientPath: '/var/opt/cluster-render/current/cluster_render_client.js',
    frameFile: '/dev/shm/waze-cluster-cards/frame.rgb',
    socket: '/dev/shm/waze-cluster-cards/ctl.sock',
    socketGroup: 'tm_oap_app',
    settingsFile: path.join(DIR, 'state', 'settings.json'),
    logFile: path.join(DIR, 'waze-cluster-cards.log'),
    // the part of the 1088x480 map the gauges leave visible (the safe area Maps on cluster gives CarPlay)
    area: { x: 286, y: 72, w: 504, h: 368 },
    margin: 6,                      // between a card and the area's edge
    turnWidth: 360,                 // the turn card's width on the cluster, in map pixels
    etaWidth: 300,                  // the arrival card's
};
const CONF_FILE = path.join(DIR, 'waze-cluster-cards.json');
const SETTINGS_DEFAULTS = { enabled: true };
const LOG_MAX = 256 * 1024;         // then the log becomes .1 and a new one starts
const ENV = Object.assign({}, process.env, { WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: '/run/wayland' });

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return {}; }
}

/* The configuration: DEFAULTS, then CONF_FILE, then the caller's (tests). */
function config(over) {
    const c = Object.assign({}, DEFAULTS, readJson(CONF_FILE), over || {});
    c.area = Object.assign({}, DEFAULTS.area, c.area);
    return c;
}

/* ---------------- logging ---------------- */

function logger(file) {
    return (s) => {
        const line = `${new Date().toISOString().slice(0, 19).replace('T', ' ')} ${s}\n`;
        process.stdout.write(line);
        if (!file) return;
        try {
            if (fs.existsSync(file) && fs.statSync(file).size > LOG_MAX) fs.renameSync(file, file + '.1');
            fs.appendFileSync(file, line);
        } catch (e) { /* logging must never stop the cards */ }
    };
}

/* ---------------- folders, settings ---------------- */

/* Node 8 has no recursive mkdir: each missing folder of dir, 0755. */
function mkdirs(dir) {
    if (fs.existsSync(dir)) return;
    mkdirs(path.dirname(dir));
    try { fs.mkdirSync(dir, 0o755); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}

/* The control socket's folder in the sticky, world-writable /dev/shm: a real
 * folder this process's user owns, never a symlink or a folder someone else
 * planted (as patchd's ensureDir). */
function ownDir(dir) {
    const uid = process.getuid ? process.getuid() : 0;
    let st = null;
    try { st = fs.lstatSync(dir); } catch (e) { st = null; }
    if (st) {
        if (!st.isDirectory() || st.uid !== uid) throw new Error(`${dir} is not a folder of uid ${uid}; refusing`);
    } else {
        fs.mkdirSync(dir, 0o755);
    }
    fs.chmodSync(dir, 0o755);
}

function groupId(name) {
    try {
        const line = fs.readFileSync('/etc/group', 'utf8').split('\n').find((l) => l.split(':')[0] === name);
        if (line) return parseInt(line.split(':')[2], 10);
    } catch (e) { /* none */ }
    return -1;
}

/* The saved settings ({ enabled }), the defaults for a missing or broken file. */
function loadSettings(file) {
    const s = Object.assign({}, SETTINGS_DEFAULTS, readJson(file));
    s.enabled = s.enabled !== false;
    return s;
}

/* Written whole: a temporary file, synced, then renamed over the old one. */
function saveSettings(file, s) {
    mkdirs(path.dirname(file));
    const tmp = `${file}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o644);
    try { fs.writeSync(fd, JSON.stringify(s) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
}

/* ---------------- the frame ---------------- */

const FRAME_BYTES = card.SCREEN.w * card.SCREEN.h * 4;
const FRAME = Buffer.alloc(FRAME_BYTES);     // every frame is read into this one buffer: a new 5.5 MB
                                             // buffer per frame left Node 8 holding over 100 MB

/* One frame of the central screen (BGRA) through file, or null when the grab
 * fails. The frame is FRAME, overwritten by the next grab: copy it to keep it. */
function grab(file) {
    return new Promise((resolve) => {
        execFile('winston-grabber', ['-s', 'center', file], { env: ENV, timeout: 3000 }, (err) => {
            if (err) return resolve(null);
            fs.open(file, 'r', (e, fd) => {
                if (e) return resolve(null);
                fs.read(fd, FRAME, 0, FRAME_BYTES, 0, (re, n) => {
                    fs.close(fd, () => {});
                    resolve(re || n !== FRAME_BYTES ? null : FRAME);
                });
            });
        });
    });
}

/* ---------------- where the cards go ---------------- */

/* The scale that draws a card of native width w at width want, within the area. */
function scaleFor(C, want, w) {
    return Math.min(want, C.area.w - 2 * C.margin) / w;
}

/* The turn card at the top of the visible area, the arrival card at its
 * bottom, each centred left to right: { target, x, y }. */
function placeFor(C, img, where) {
    const x = C.area.x + Math.round((C.area.w - img.w) / 2);
    const y = where === 'top' ? C.area.y + C.margin : C.area.y + C.area.h - C.margin - img.h;
    return { target: 'map', x, y };
}

/* What the frame shows: { view, turn, arrival } with the layer images, or
 * null; the shares that decided, for the log, in why. */
function findCards(C, buf, why) {
    const t = card.hasTurn(buf);
    if (t.found) {
        const turn = card.composeTurn(buf, t.rect, scaleFor(C, C.turnWidth, card.DEFAULTS.turn.w));
        const arrival = card.hasArrival(buf).found ? card.composeArrival(buf, scaleFor(C, C.etaWidth, card.DEFAULTS.arrival.w)) : null;
        return { view: 'full screen', turn, arrival };
    }
    const d = card.hasDashboard(buf);
    if (d.found) {
        const turn = card.composeDashCard(buf, d, scaleFor(C, C.turnWidth, card.DASH.card.w));
        const arrival = card.composeDashEta(buf, d, scaleFor(C, C.etaWidth, card.DASH.eta.w));
        return { view: 'Dashboard', turn, arrival };
    }
    if (why) {
        why.text = `turn black ${(t.black * 100).toFixed(1)}%; Dashboard gap ${(d.gap * 100).toFixed(0)}%, ` +
            `card ${(d.panel * 100).toFixed(0)}%, pill ${(d.pill * 100).toFixed(0)}%`;
    }
    return null;
}

/* ---------------- layers ---------------- */

/**
 * One card's image layer: made when first shown, hidden when the card goes,
 * dropped when it has stayed hidden for dropAfterMs. show(img, place) puts it
 * at place ({ target, x, y }); another size or place makes the layer again.
 * Pixels go only when the picture changed.
 */
function cardLayer(cr, name, C, log) {
    let ref = 0, shown = false, hash = '', last = null, hiddenAt = 0, geom = '';
    const drop = () => { if (ref) cr.drop(ref); ref = 0; hash = ''; last = null; shown = false; hiddenAt = 0; };
    return {
        show(img, place) {
            const g = `${place.target} ${img.w}x${img.h}@${place.x},${place.y}`;
            if (ref && g !== geom) { drop(); log(`${name} card now ${g}`); }
            const h = crypto.createHash('md5').update(img.rgba).digest('hex');
            if (!ref) {
                ref = cr.image({ target: place.target, klass: 'overlay', x: place.x, y: place.y, w: img.w, h: img.h, iw: img.w, ih: img.h });
                if (!ref) { log(`${name} card refused by the client (${g})`); return; }
                geom = g;
            } else if (!shown) {
                cr.set(ref, { visible: 1 });
            }
            if (h !== hash) { cr.pixels(ref, null, img.rgba); hash = h; last = img.rgba; }
            if (!shown) log(`${name} card shown (${g})`);
            shown = true; hiddenAt = 0;
        },
        hide() {
            if (shown && ref) { cr.set(ref, { visible: 0 }); log(`${name} card hidden`); hiddenAt = Date.now(); }
            shown = false;
            if (ref && hiddenAt && Date.now() - hiddenAt > C.dropAfterMs) drop();
        },
        resend() { if (ref && last) cr.pixels(ref, null, last); },
        drop,
        get shown() { return shown; },
    };
}

/* ---------------- is the Waze map on the cluster ---------------- */

/**
 * Whether the map producer's video layer on `map` is shown, from
 * cluster-render's status text, every mapPollMs: the copy the renderer
 * writes each second (statusFile), which costs it nothing more, while that
 * is fresh; else asked over the socket. shown() is false while the renderer
 * is not connected or its status is older than mapStaleMs.
 */
function mapWatch(cr, C, log) {
    const re = new RegExp(`^layer \\d+ video of ${C.mapProducer.replace(/[^\w-]/g, '')} on map, [^\\n]*: shown$`, 'm');
    let shown = false, at = 0, said = null;
    const take = (text) => {
        shown = re.test(String(text || ''));
        at = Date.now();
        if (shown !== said) { log(`cluster map ${shown ? 'shown' : 'not shown'}`); said = shown; }
    };
    cr.on('status', take);
    const fromFile = () => {
        if (!C.statusFile) return false;
        try {
            if (Date.now() - fs.statSync(C.statusFile).mtime.getTime() > C.mapStaleMs) return false;
            take(fs.readFileSync(C.statusFile, 'utf8'));
            return true;
        } catch (e) {
            return false;
        }
    };
    const ask = () => { if (cr.ready && !fromFile()) cr.status(); };
    return {
        ask,
        shown() { return !!cr.ready && shown && Date.now() - at <= C.mapStaleMs; },
    };
}

/* ---------------- the control socket ---------------- */

/**
 * The app's socket. state() gives the status object; onCards(on) saves a
 * switch and returns { ok, reason }. Returns { broadcast(), close() }.
 */
function control(C, log, state, onCards) {
    const clients = [];
    const line = (obj) => JSON.stringify(obj) + '\n';
    const send = (c, obj) => { try { c.write(line(obj)); } catch (e) { /* gone */ } };
    const server = net.createServer((c) => {
        if (clients.length >= 8) { c.end(); return; }
        clients.push(c);
        c.setEncoding('utf8');
        let buf = '';
        c.on('data', (chunk) => {
            buf += chunk;
            if (buf.length > 4096) { c.destroy(); return; }
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const text = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!text) continue;
                let msg = null;
                try { msg = JSON.parse(text); } catch (e) { msg = null; }
                if (!msg || typeof msg !== 'object') continue;
                if (msg.cmd === 'status') {
                    send(c, state());
                } else if (msg.cmd === 'cards') {
                    const on = msg.on === 1 || msg.on === '1' || msg.on === true ? true
                        : msg.on === 0 || msg.on === '0' || msg.on === false ? false : null;
                    const r = on === null ? { ok: false, reason: 'on must be 0 or 1' } : onCards(on);
                    send(c, { ev: 'cards-reply', ok: r.ok, reason: r.reason || '' });
                }
            }
        });
        const gone = () => { const i = clients.indexOf(c); if (i >= 0) clients.splice(i, 1); };
        c.on('close', gone);
        c.on('error', gone);
        send(c, state());
    });
    ownDir(path.dirname(C.socket));
    try { if (fs.lstatSync(C.socket)) fs.unlinkSync(C.socket); } catch (e) { /* none */ }
    server.on('error', (e) => log(`control socket: ${e.message}`));
    server.listen(C.socket, () => {
        if (process.getuid && process.getuid() === 0 && C.socketGroup) {
            const gid = groupId(C.socketGroup);
            if (gid >= 0) try { fs.chownSync(C.socket, 0, gid); } catch (e) { /* stays root's */ }
        }
        try { fs.chmodSync(C.socket, 0o660); } catch (e) { /* as made */ }
        log(`control socket on ${C.socket}`);
    });
    return {
        broadcast() { const s = state(); clients.forEach((c) => send(c, s)); },
        close() { clients.forEach((c) => c.destroy()); server.close(); },
    };
}

/* ---------------- the loop ---------------- */

/**
 * The service. opts (tests): conf (over the configuration), grab(file),
 * ClusterRender (the client class), sleep(ms), log(line), loops (stop after
 * that many turns), started(stop) given the function that ends the loop.
 */
async function run(opts) {
    opts = opts || {};
    const C = config(opts.conf);
    const log = opts.log || logger(C.logFile);
    const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const grabFrame = opts.grab || grab;
    if (!opts.grab) ownDir(path.dirname(C.frameFile));
    const ClusterRender = opts.ClusterRender || require(C.clientPath).ClusterRender;
    const cr = new ClusterRender('waze-cluster-cards');
    const turnLayer = cardLayer(cr, 'turn', C, log);
    const arrivalLayer = cardLayer(cr, 'arrival', C, log);
    const map = mapWatch(cr, C, log);
    let settings = loadSettings(C.settingsFile);
    let state = 'waiting', view = '', stopping = false, loops = 0;
    let seen = 0, missed = 0, failures = 0, lastSeenAt = 0;

    const status = () => ({ ev: 'status', on: settings.enabled ? 1 : 0, state, view });
    const ctl = control(C, log, status, (on) => {
        try {
            saveSettings(C.settingsFile, Object.assign({}, settings, { enabled: on }));
        } catch (e) {
            log(`settings not saved: ${e.message}`);
            return { ok: false, reason: `not saved: ${e.message}` };
        }
        if (settings.enabled !== on) log(`switched ${on ? 'on' : 'off'} in the app`);
        settings = Object.assign({}, settings, { enabled: on });
        setState(on ? 'waiting' : 'off', '');
        return { ok: true };
    });
    function setState(s, v) {
        if (s === state && v === view) return;
        state = s; view = v;
        log(`state: ${s}${v ? ` (${v})` : ''}`);
        ctl.broadcast();
    }

    cr.on('layer', (ref, st, reason) => { if (st !== 'shown' && st !== 'hidden') log(`layer ${ref}: ${st}${reason ? ` (${reason})` : ''}`); });
    cr.on('refused', (op, ref, reason) => log(`cluster-render refused ${op} ${ref || ''}: ${reason}`));
    cr.on('ready', () => { log('cluster-render connected'); turnLayer.resend(); arrivalLayer.resend(); map.ask(); });
    cr.on('disconnected', () => log('cluster-render disconnected'));
    cr.connect();
    const poll = setInterval(map.ask, C.mapPollMs);

    const dropAll = () => { turnLayer.drop(); arrivalLayer.drop(); seen = 0; missed = 0; };
    const hideAll = () => { turnLayer.hide(); arrivalLayer.hide(); };
    const stop = () => {
        if (stopping) return;
        stopping = true;
        clearInterval(poll);
        dropAll();
        ctl.close();
        if (!opts.loops) setTimeout(() => { cr.close(); process.exit(0); }, 300);
        else cr.close();
    };
    if (!opts.loops) {
        process.on('SIGTERM', stop);
        process.on('SIGINT', stop);
    }
    if (opts.started) opts.started(stop);

    log(`running: ${C.fps} fps (${C.idleFps} while idle), cards in ${C.area.w}x${C.area.h}+${C.area.x}+${C.area.y} of the map`);
    setState(settings.enabled ? 'waiting' : 'off', '');
    while (!stopping) {
        if (opts.loops && ++loops > opts.loops) { stop(); break; }
        const t0 = Date.now();

        // switched off: nothing on the cluster, no grabs
        if (!settings.enabled) {
            dropAll();
            setState('off', '');
            await sleep(1000);
            continue;
        }
        // no Waze map on the cluster: no cards (they would hold the map area on their own), no grabs
        if (!cr.ready || !map.shown()) {
            hideAll();
            seen = 0; missed = 0;
            setState(cr.ready ? 'waiting' : 'unavailable', '');
            await sleep(500);
            continue;
        }

        const buf = await grabFrame(C.frameFile);
        if (!buf) {
            // no grab (screen off, compositor restarting): no card, back off a little
            failures++;
            if (failures === 1 || failures % 60 === 0) log(`grab failed (${failures} in a row)`);
            missed++; seen = 0;
        } else {
            failures = 0;
            const why = {};
            const found = findCards(C, buf, why);
            if (found) {
                seen++; missed = 0; lastSeenAt = Date.now();
                if (seen >= C.showAfter) {
                    turnLayer.show(found.turn, placeFor(C, found.turn, 'top'));
                    if (found.arrival) arrivalLayer.show(found.arrival, placeFor(C, found.arrival, 'bottom'));
                    else arrivalLayer.hide();
                    setState('showing', found.view);
                }
            } else {
                if (turnLayer.shown && missed === 0) log(`cards lost (${view}): ${why.text}`);
                missed++; seen = 0;
            }
        }
        if (missed >= C.hideAfter) {
            hideAll();
            setState('looking', '');
        } else if (state !== 'showing') {
            setState('looking', '');
        }
        const idle = !turnLayer.shown && Date.now() - lastSeenAt > C.idleAfterMs;
        const period = 1000 / (idle ? C.idleFps : C.fps);
        await sleep(Math.max(20, period - (Date.now() - t0)) + (failures ? Math.min(failures, 10) * 100 : 0));
    }
}

/* One frame, what it shows, then exit. */
async function once() {
    const C = config();
    const log = logger(null);
    ownDir(path.dirname(C.frameFile));
    const file = C.frameFile.replace(/\.rgb$/, '-once.rgb');
    const buf = await grab(file);
    if (!buf) { log('grab failed'); process.exit(1); }
    const t = card.hasTurn(buf), a = card.hasArrival(buf), d = card.hasDashboard(buf);
    log(`full screen: turn ${t.found}${t.rect ? ` at y ${t.rect.y}, ${t.rect.h} high` : ''} (black ${(t.black * 100).toFixed(0)}%, ` +
        `white ${(t.white * 100).toFixed(0)}%), arrival ${a.found} (panel ${(a.panel * 100).toFixed(0)}%, edges ${(a.edges * 100).toFixed(0)}%)`);
    log(`Dashboard: ${d.found}${d.found ? (d.then ? ', with then' : ', without then') : ''} ` +
        `(gap ${(d.gap * 100).toFixed(0)}%, card ${(d.panel * 100).toFixed(0)}%, pill ${(d.pill * 100).toFixed(0)}%)`);
    log(`settings: ${JSON.stringify(loadSettings(C.settingsFile))}`);
    process.exit(0);
}

if (require.main === module) {
    const log = logger(DEFAULTS.logFile);
    (process.argv.indexOf('--once') >= 0 ? once() : run({ log })).catch((e) => { log(`fatal: ${e && e.stack || e}`); process.exit(1); });
}

module.exports = { run, config, findCards, placeFor, scaleFor, loadSettings, saveSettings, DEFAULTS, SETTINGS_DEFAULTS };
