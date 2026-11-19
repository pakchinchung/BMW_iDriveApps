// SPDX-License-Identifier: MIT
'use strict';
/**
 * The cards service on the PC: synthetic frames of Waze's full-screen map
 * and CarPlay's Dashboard (drawn to the geometry card.js measures), the real
 * service loop against a fake cluster-render client, and its control socket
 * as the app uses it.
 *
 *   node native/waze-cluster-cards/test/cards_test.js
 *
 * Covers: card.js finds the turn and arrival cards on a full-screen frame
 * and the guidance card and ETA pill on a Dashboard frame, nothing on a
 * blank one or a map without cards; the cards' layers are overlay images on
 * `map`, inside the visible area, the turn card at its top and the arrival
 * card at its bottom; nothing is drawn or grabbed while waze-on-cluster's
 * map is not shown on the cluster (or shown only on the HUD, or another
 * app's), nor while cluster-render does not answer; the cards hide once the
 * map goes and once Waze's cards go; the switch over the socket: status on
 * connect, cards 0 drops every layer and is saved, cards 1 brings them back,
 * a bad value is refused, the saved setting is read at start; pixels are
 * sent again only when the picture changed.
 */
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const card = require('../src/card');
const svc = require('../src/cards');

const W = card.SCREEN.w, H = card.SCREEN.h;
let passed = 0;
const ok = (cond, what) => { assert(cond, what); passed++; };

/* ---- synthetic frames (BGRA) ---- */
function frame(rgb) {
    const b = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) { b[i * 4] = rgb[2]; b[i * 4 + 1] = rgb[1]; b[i * 4 + 2] = rgb[0]; b[i * 4 + 3] = 255; }
    return b;
}
function fill(b, x, y, w, h, rgb, rad) {
    for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
            if (rad) {
                const cx = xx < x + rad ? x + rad : (xx > x + w - 1 - rad ? x + w - 1 - rad : xx);
                const cy = yy < y + rad ? y + rad : (yy > y + h - 1 - rad ? y + h - 1 - rad : yy);
                if ((xx - cx) * (xx - cx) + (yy - cy) * (yy - cy) > rad * rad) continue;
            }
            const i = (yy * W + xx) * 4;
            b[i] = rgb[2]; b[i + 1] = rgb[1]; b[i + 2] = rgb[0]; b[i + 3] = 255;
        }
    }
}
const WHITE = [250, 250, 250];

/* Waze's full-screen map: a grey map, the black turn card top right with
 * white text, the grey arrival card bottom right with a dark 1-px edge. */
function fullScreen(textX) {
    const b = frame([120, 128, 120]);
    const t = card.DEFAULTS.turn, a = card.DEFAULTS.arrival;
    fill(b, t.x, 40, t.w, t.h, [8, 8, 8], t.radius);
    fill(b, t.x + 100 + (textX || 0), 40 + 50, 260, 60, WHITE);       // the arrow, distance and street
    fill(b, a.x - 1, a.y, 1, a.h, [12, 12, 12]);
    fill(b, a.x + a.w, a.y, 1, a.h, [12, 12, 12]);
    fill(b, a.x, a.y, a.w, a.h, [55, 67, 81]);
    fill(b, a.x + 80, a.y + 50, 200, 40, WHITE);                        // the arrival time
    return b;
}

/* CarPlay's Dashboard: dark background, the grey-blue guidance card top
 * left, the ETA pill at the bottom of the map tile. */
function dashboard() {
    const b = frame([10, 10, 12]);
    const c = card.DASH.card, e = card.DASH.eta;
    fill(b, 760, 160, 900, 430, [90, 100, 90]);                         // the map tile, right of the gap
    fill(b, c.x, c.y, c.w, c.mainH, [45, 46, 64], c.radius);
    fill(b, c.x + 120, c.y + 60, 300, 70, WHITE);
    fill(b, 745, e.y, 830, e.h, [53, 66, 80]);                          // the pill, wider than its text
    fill(b, e.x + 60, e.y + 25, 220, 35, WHITE);
    return b;
}

const FULL = fullScreen(), FULL2 = fullScreen(30), DASH = dashboard();
const BLANK = frame([0, 0, 0]), MAP_ONLY = frame([120, 128, 120]);

/* ---- card.js on them ---- */
function detection() {
    const t = card.hasTurn(FULL), a = card.hasArrival(FULL);
    ok(t.found && t.rect.x === card.DEFAULTS.turn.x && Math.abs(t.rect.y - 40) <= 2 && Math.abs(t.rect.h - 221) <= 3,
        `full screen: the turn card found where drawn (${JSON.stringify(t.rect)})`);
    ok(a.found, `full screen: the arrival card found (${JSON.stringify(a)})`);
    ok(!card.hasDashboard(FULL).found, 'full screen is not the Dashboard');
    const d = card.hasDashboard(DASH);
    ok(d.found && !d.then, `Dashboard: the card and pill found, no then strip (${JSON.stringify(Object.assign({}, d, { card: 0, eta: 0 }))})`);
    ok(!card.hasTurn(DASH).found, 'the Dashboard has no full-screen turn card');
    [BLANK, MAP_ONLY].forEach((f, i) => ok(!card.hasTurn(f).found && !card.hasArrival(f).found && !card.hasDashboard(f).found,
        `${['a blank frame', 'a map without cards'][i]}: nothing`));
    console.log('ok   card.js: the full-screen cards, the Dashboard card and pill; nothing on a blank frame or a bare map');
}

/* ---- a cluster-render client that only remembers what it was asked ---- */
let instance = null;
class FakeClusterRender {
    constructor(app) {
        this.app = app; this.handlers = {}; this.layers = new Map(); this.nextRef = 1; this.ready = false;
        this.pixelWrites = 0; this.statusAsks = 0; this.statusText = ''; this.answer = true;
        instance = this;
    }
    on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
    emit(ev, ...a) { (this.handlers[ev] || []).forEach((fn) => fn(...a)); }
    connect() { this.ready = true; setImmediate(() => this.emit('ready')); }
    close() { this.ready = false; }
    image(o) { const ref = this.nextRef++; this.layers.set(ref, Object.assign({ kind: 'image', visible: 1 }, o)); return ref; }
    set(ref, o) { Object.assign(this.layers.get(ref), o); }
    drop(ref) { this.layers.delete(ref); }
    pixels(ref, rects, px) { this.pixelWrites++; this.layers.get(ref).bytes = px.length; return true; }
    status() { this.statusAsks++; if (this.answer) setImmediate(() => this.emit('status', this.statusText)); }
    visible() { return [...this.layers.values()].filter((l) => l.visible !== 0); }
}

const MAP_SHOWN = 'upload: cap 5500 KB/s\ntarget map: slot 0x100 scene 0x10004f0 1088x480: shown\n' +
    'layer 3 video of waze-on-cluster on map, content z 0: shown\n  frames 120\n';
const MAP_WAITING = 'target map: slot 0x100: waiting (stock)\nlayer 3 video of waze-on-cluster on map, content z 0: waiting - parked\n';
const HUD_ONLY = 'layer 4 video of waze-on-cluster on hud, content z 0, yield 0: shown\n';
const OTHER_APP = 'layer 9 video of wazecard on map, content z 0: shown\n';

/* ---- a client of the control socket ---- */
function client(sock) {
    return new Promise((resolve, reject) => {
        const c = net.connect(sock);
        const msgs = [];
        let buf = '';
        c.setEncoding('utf8');
        c.on('data', (d) => {
            buf += d;
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) { msgs.push(JSON.parse(buf.slice(0, nl))); buf = buf.slice(nl + 1); }
        });
        c.on('error', reject);
        c.on('connect', () => resolve({ c, msgs, send: (o) => c.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n') }));
    });
}

const tick = () => new Promise((r) => setTimeout(r, 2));
async function until(what, check, ms) {
    const end = Date.now() + (ms || 3000);
    while (!check()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
}

async function service() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcc-'));
    const sock = path.join(dir, 'ctl.sock');
    const settingsFile = path.join(dir, 'state', 'settings.json');
    let f = FULL, grabs = 0, done = false;
    const C = { socket: sock, settingsFile, logFile: null, frameFile: path.join(dir, 'frame.rgb'), mapPollMs: 5, mapStaleMs: 400, idleAfterMs: 1e9 };
    const lines = [];
    let stop = null;
    const run = svc.run({
        conf: C, ClusterRender: FakeClusterRender, loops: 1e9, log: (s) => lines.push(s), started: (s) => { stop = s; },
        sleep: tick, grab: () => { grabs++; return Promise.resolve(f); },
    }).then(() => { done = true; });
    await until('the service up', () => instance && fs.existsSync(sock));
    const cr = instance;
    const area = svc.DEFAULTS.area;

    // no map on the cluster: nothing drawn, nothing grabbed
    cr.statusText = MAP_WAITING;
    const app = await client(sock);
    await until('the first status', () => app.msgs.length >= 1);
    ok(app.msgs[0].ev === 'status' && app.msgs[0].on === 1, `status on connect, on by default (${JSON.stringify(app.msgs[0])})`);
    await until('waiting', () => app.msgs.some((m) => m.state === 'waiting') && cr.statusAsks > 3);
    ok(grabs === 0 && cr.layers.size === 0, 'map parked behind BMW\'s: no grab, no layer');
    [HUD_ONLY, OTHER_APP].forEach((text) => { cr.statusText = text; });
    await new Promise((r) => setTimeout(r, 50));
    ok(grabs === 0 && cr.layers.size === 0, 'a map only on the HUD, or another app\'s video on map: no grab, no layer');
    console.log('ok   no Waze map on the cluster (parked, on the HUD only, another app\'s): nothing grabbed or drawn');

    // the map shows: the full-screen cards, inside the visible area
    cr.statusText = MAP_SHOWN;
    await until('showing', () => app.msgs.some((m) => m.state === 'showing' && m.view === 'full screen') && cr.visible().length === 2);
    const [turn, eta] = cr.visible().sort((p, q) => p.y - q.y);
    ok(cr.visible().every((l) => l.target === 'map' && l.klass === 'overlay' && !l.contend), 'two overlay images on map, not contending');
    ok(cr.visible().every((l) => l.x >= area.x && l.x + l.w <= area.x + area.w && l.y >= area.y && l.y + l.h <= area.y + area.h),
        `both inside the visible ${area.w}x${area.h}+${area.x}+${area.y} (${JSON.stringify(cr.visible().map((l) => [l.x, l.y, l.w, l.h]))})`);
    ok(turn.w === svc.DEFAULTS.turnWidth && turn.y === area.y + svc.DEFAULTS.margin, 'the turn card at the top, at its width');
    ok(eta.w === svc.DEFAULTS.etaWidth && eta.y + eta.h === area.y + area.h - svc.DEFAULTS.margin, 'the arrival card at the bottom, at its width');
    ok(Math.abs((turn.x + turn.w / 2) - (area.x + area.w / 2)) <= 1 && Math.abs((eta.x + eta.w / 2) - (area.x + area.w / 2)) <= 1, 'both centred');
    const writes = cr.pixelWrites;
    await new Promise((r) => setTimeout(r, 60));
    ok(cr.pixelWrites === writes, `the same picture is not sent again (${cr.pixelWrites - writes} writes)`);
    f = FULL2;
    await until('a changed turn card sent', () => cr.pixelWrites > writes);
    console.log('ok   the map shown: the turn card at the top and the arrival card at the bottom of the visible area, overlays on map; ' +
        'pixels only when they change');

    // Dashboard
    f = DASH;
    await until('the Dashboard', () => app.msgs.some((m) => m.state === 'showing' && m.view === 'Dashboard') && cr.visible().length === 2);
    ok(cr.visible().every((l) => l.x >= area.x && l.x + l.w <= area.x + area.w && l.y >= area.y && l.y + l.h <= area.y + area.h),
        'the Dashboard\'s card and pill inside the visible area');
    console.log('ok   CarPlay\'s Dashboard: its guidance card and ETA pill, in the same places');

    // Waze's cards go: hidden after hideAfter frames
    f = MAP_ONLY;
    await until('looking', () => app.msgs[app.msgs.length - 1].state === 'looking' && cr.visible().length === 0);
    ok(cr.layers.size > 0, 'hidden, kept for a while');
    f = FULL;
    await until('back', () => cr.visible().length === 2);
    console.log('ok   Waze\'s cards gone from the central screen: hidden; back when they come back');

    // the map goes: the cards go at once, grabbing stops
    cr.statusText = MAP_WAITING;
    await until('waiting again', () => app.msgs[app.msgs.length - 1].state === 'waiting' && cr.visible().length === 0);
    let g = grabs;
    await new Promise((r) => setTimeout(r, 50));
    ok(grabs === g, 'no grabs while the map is not on the cluster');
    // cluster-render stops answering: the map counts as gone
    cr.statusText = MAP_SHOWN;
    await until('shown again', () => cr.visible().length === 2);
    cr.answer = false;
    await until('stale: hidden', () => cr.visible().length === 0, 2000);
    cr.answer = true;
    await until('answers again', () => cr.visible().length === 2);
    console.log('ok   the map gone from the cluster, or cluster-render silent: the cards hide and grabbing stops');

    // the switch
    app.send({ cmd: 'cards', on: 0 });
    const from = app.msgs.length;
    await until('off', () => app.msgs.slice(from).some((m) => m.ev === 'cards-reply' && m.ok) &&
        app.msgs.slice(from).some((m) => m.ev === 'status' && m.on === 0 && m.state === 'off'));
    await until('dropped', () => cr.layers.size === 0);
    ok(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).enabled === false, 'off saved');
    g = grabs;
    await new Promise((r) => setTimeout(r, 50));
    ok(grabs === g, 'no grabs while off');
    const other = await client(sock);
    await until('a second client\'s status', () => other.msgs.length >= 1);
    ok(other.msgs[0].on === 0 && other.msgs[0].state === 'off', 'a second client sees it off');
    app.send({ cmd: 'cards', on: 'maybe' });
    app.send('not json');
    app.send({ cmd: 'status' });
    await until('refused', () => app.msgs.some((m) => m.ev === 'cards-reply' && !m.ok));
    ok(app.msgs[app.msgs.length - 1].ev === 'status', 'a bad line ignored, status answered');
    app.send({ cmd: 'cards', on: 1 });
    await until('on again', () => cr.visible().length === 2 && other.msgs.some((m) => m.on === 1 && m.state === 'showing'));
    ok(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).enabled === true, 'on saved');
    console.log('ok   the switch: off drops every layer, stops grabbing and is saved; on brings the cards back; every client told; ' +
        'a bad value refused');

    app.c.destroy(); other.c.destroy();
    stop();
    await run;
    ok(done && cr.layers.size === 0, 'stopped: every layer dropped');
    ok(!lines.some((l) => /fatal|refused/.test(l)), lines.filter((l) => /fatal|refused/.test(l)).join('\n'));
    return { dir };
}

async function savedAtStart(dir) {
    const settingsFile = path.join(dir, 'state2', 'settings.json');
    svc.saveSettings(settingsFile, { enabled: false });
    ok(svc.loadSettings(settingsFile).enabled === false, 'saved off read back');
    ok(svc.loadSettings(path.join(dir, 'none.json')).enabled === true, 'no file: on');
    fs.writeFileSync(path.join(dir, 'broken.json'), '{');
    ok(svc.loadSettings(path.join(dir, 'broken.json')).enabled === true, 'a broken file: on');
    const sock = path.join(dir, 'ctl2.sock');
    let grabs = 0;
    const p = svc.run({
        conf: { socket: sock, settingsFile, logFile: null, mapPollMs: 5 }, ClusterRender: FakeClusterRender, loops: 30, log: () => {},
        sleep: tick, grab: () => { grabs++; return Promise.resolve(FULL); },
    });
    instance.statusText = MAP_SHOWN;
    await p;
    ok(grabs === 0 && instance.layers.size === 0, 'off at start: nothing grabbed or drawn');
    console.log('ok   the saved setting: read at start (off: nothing), on without a file or with a broken one');
}

function layout() {
    const C = svc.config({});
    // the tallest cards: a turn with its then line (330 high) and the Dashboard card with its then strip
    const turnH = Math.round(card.DEFAULTS.turn.h * svc.scaleFor(C, C.turnWidth, card.DEFAULTS.turn.w));
    const dashH = Math.round((card.DASH.card.mainH + card.DASH.card.thenH) * svc.scaleFor(C, C.turnWidth, card.DASH.card.w));
    const etaH = Math.round(card.DEFAULTS.arrival.h * svc.scaleFor(C, C.etaWidth, card.DEFAULTS.arrival.w));
    ok(Math.max(turnH, dashH) + etaH + 3 * C.margin < C.area.h - 100, `the cards leave at least 100 px of map between them (${turnH}/${dashH}, ${etaH})`);
    const wide = svc.config({ turnWidth: 2000 });
    ok(Math.round(card.DEFAULTS.turn.w * svc.scaleFor(wide, wide.turnWidth, card.DEFAULTS.turn.w)) === wide.area.w - 2 * wide.margin,
        'a card asked wider than the area fits inside it');
    console.log('ok   the layout: the cards leave the map between them; never wider than the visible area');
}

(async () => {
    detection();
    layout();
    const r = await service();
    await savedAtStart(r.dir);
    console.log(`${passed} checks passed`);
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
