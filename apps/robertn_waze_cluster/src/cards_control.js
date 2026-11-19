// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * cards_control - the app's client of the waze-cluster-cards tool, which
 * draws Waze's turn card and arrival card over the Waze map on the cluster.
 * Opened while the main page is visible, like the other sockets.
 *
 *   Cards socket (CARDS_PATH; root service, group tm_oap_app)
 *     app     -> service  {"cmd":"cards","on":0|1}   saved by the service
 *     service -> app      {"ev":"status","on":0|1,"state":"off"|"unavailable"|
 *                          "waiting"|"looking"|"showing","view"}
 *                         {"ev":"cards-reply","ok","reason"}
 *
 * The checkbox's tick: the switch just asked for until the service's status
 * has it (or it refuses, or the socket goes), else the service's.
 */
'use strict';

const EventEmitter = require('events');
const { LineSocket } = require('./waze_cluster_control.js');
const { t } = require('./i18n.js');

const CARDS_PATH = '/dev/shm/waze-cluster-cards/ctl.sock';

class CardsControl extends EventEmitter {
    /* options: path, retryMs, log ({info, warn}). Emits 'change'. */
    constructor(options) {
        super();
        const o = options || {};
        this._log = o.log || { info() {}, warn() {} };
        this.status = null;      /* the service's last status while connected */
        this._asked = null;      /* true / false: a switch sent, not answered yet */
        this.socket = new LineSocket({
            path: o.path || CARDS_PATH,
            retryMs: o.retryMs,
            log: this._log,
            onMessage: (msg) => this._onMessage(msg)
        });
        const reset = () => { this.status = null; this._asked = null; this.emit('change'); };
        this.socket.on('connect', reset);
        this.socket.on('close', reset);
    }

    open() {
        this.socket.open();
    }

    close() {
        this.socket.close();
        this.status = null;
        this._asked = null;
        this.emit('change');
    }

    /* Whether the cards are switched on: as just asked, else as the service
     * said; null while it has not. */
    enabled() {
        if (this._asked !== null) {
            return this._asked;
        }
        return this.status ? this.status.on === 1 : null;
    }

    canToggle() {
        return this.socket.connected() && !!this.status;
    }

    toggle() {
        if (this.canToggle()) {
            this._asked = !this.enabled();
            this.socket.send({ cmd: 'cards', on: this._asked ? 1 : 0 });
            this.emit('change');
        }
    }

    text() {
        return t('Waze cards: {0}', this._state());
    }

    _state() {
        const link = this.socket.link;
        if (link === 'down') {
            return t('Connecting…');
        }
        if (link !== 'up' || !this.status) {
            return link === 'up' ? t('Connecting…') : t('Unavailable');
        }
        if (this.enabled() === false) {
            return t('Off');
        }
        switch (this.status.state) {
        case 'showing':
            return t('Showing');
        case 'looking':
            return t('Waiting for Waze');
        case 'waiting':
        case 'off':      /* switched on, the service's next status not here yet */
            return t('Waiting for the cluster map');
        default:
            return t('Unavailable');
        }
    }

    _onMessage(msg) {
        if (msg.ev === 'status') {
            this.status = msg;
            if (this._asked !== null && (msg.on === 1) === this._asked) {
                this._asked = null;
            }
            this.emit('change');
        } else if (msg.ev === 'cards-reply' && !msg.ok) {
            this._log.info(`the cards service did not take the switch: ${msg.reason || 'refused'}`);
            this._asked = null;
            this.emit('change');
        }
    }
}

module.exports = { CardsControl, CARDS_PATH };
