/**
 * Editor side of the Cognimates editor bridge.
 *
 * The host is passive: it does nothing unless the editor is embedded in a
 * frame AND the embedding window, from an allowed origin, sends a valid
 * "hello". The editor keeps working normally without it.
 *
 * Security properties enforced here:
 * - messages are only accepted from window.parent (event.source check);
 * - the sender origin must be on an explicit allow-list (never "*");
 * - replies are posted to that exact origin, never "*";
 * - after the handshake, requests must come from the same origin and carry
 *   the session id issued in the handshake;
 * - every payload is validated against the protocol schema before the
 *   adapter is called; there is no request type that evaluates code.
 */
import {
    CAPABILITIES,
    ERROR_CODES,
    KINDS,
    LIMITS,
    PROTOCOL_VERSION,
    isBoundedString,
    isEnvelope,
    makeEnvelope,
    makeId,
    normalizeOrigin,
    parseOriginList,
    validateRequest
} from './protocol';

const ADAPTER_METHODS = {
    getContext: 'getContext',
    importAsset: 'importAsset',
    highlightBlocks: 'highlightBlocks',
    clearHighlights: 'clearHighlights',
    exportProject: 'exportProject',
    loadProject: 'loadProject',
    markSaved: 'markSaved',
    setLanguage: 'setLanguage',
    startTrace: 'startTrace',
    stopTrace: 'stopTrace'
};

/**
 * Error type adapters throw to send a specific protocol error code.
 */
class BridgeError extends Error {
    constructor (code, message) {
        super(message);
        this.code = code;
    }
}

/**
 * Build the list of parent origins the editor accepts.
 * The editor's own origin is always allowed (same-site /editor/ deployment).
 * @param {string} configured comma separated origins from build config
 * @param {string} selfOrigin window.location.origin
 * @return {Array.<string>} allowed origins
 */
const resolveAllowedParentOrigins = (configured, selfOrigin) => {
    const list = parseOriginList(configured || '');
    const self = normalizeOrigin(selfOrigin);
    if (self && list.indexOf(self) === -1) list.push(self);
    return list;
};

class BridgeHost {
    /**
     * @param {object} options host options
     * @param {Window} options.win the editor window
     * @param {Array.<string>} options.allowedOrigins allowed parent origins
     * @param {object} options.adapter editor adapter (see vm-adapter.js)
     * @param {object} [options.editorInfo] name/version reported in the handshake
     * @param {function} [options.onWarn] diagnostics callback
     */
    constructor (options) {
        this.win = options.win;
        this.allowedOrigins = (options.allowedOrigins || []).map(normalizeOrigin).filter(Boolean);
        this.adapter = options.adapter;
        this.editorInfo = options.editorInfo || {name: 'cognimates-gui', version: 'unknown'};
        this.onWarn = options.onWarn || (() => {});
        this.parentOrigin = null;
        this.sessionId = null;
        this.started = false;
        this.handleMessage = this.handleMessage.bind(this);
        this._unsubscribe = null;
    }

    isEmbedded () {
        try {
            return !!this.win && !!this.win.parent && this.win.parent !== this.win;
        } catch (e) {
            return false;
        }
    }

    start () {
        if (this.started || !this.isEmbedded()) return false;
        this.win.addEventListener('message', this.handleMessage);
        if (this.adapter && typeof this.adapter.subscribe === 'function') {
            this._unsubscribe = this.adapter.subscribe((type, payload) => this.emitEvent(type, payload));
        }
        this.started = true;
        return true;
    }

    stop () {
        if (!this.started) return;
        this.win.removeEventListener('message', this.handleMessage);
        if (this._unsubscribe) this._unsubscribe();
        this._unsubscribe = null;
        this.started = false;
        this.parentOrigin = null;
        this.sessionId = null;
    }

    isConnected () {
        return !!(this.parentOrigin && this.sessionId);
    }

    _post (message, transfer) {
        if (!this.parentOrigin) return;
        try {
            this.win.parent.postMessage(message, this.parentOrigin, transfer || []);
        } catch (e) {
            this.onWarn('postMessage failed', e);
        }
    }

    emitEvent (type, payload) {
        if (!this.isConnected()) return;
        this._post(makeEnvelope(KINDS.EVENT, {sessionId: this.sessionId, type: type, payload: payload || {}}));
    }

    handleMessage (event) {
        // 1. Only our direct parent may talk to us.
        if (!event || event.source !== this.win.parent) return;
        // 2. Only allow-listed origins. Unknown origins get no reply at all.
        const origin = normalizeOrigin(event.origin);
        if (!origin || this.allowedOrigins.indexOf(origin) === -1) {
            this.onWarn(`Ignoring bridge message from unexpected origin ${String(event.origin)}`);
            return;
        }
        const data = event.data;
        if (!isEnvelope(data)) return;

        if (data.kind === KINDS.HELLO) {
            const payload = data.payload || {};
            if (!isBoundedString(payload.nonce, LIMITS.MAX_MESSAGE_ID_LENGTH)) return;
            if (payload.protocolVersion !== PROTOCOL_VERSION) return;
            this.parentOrigin = origin;
            this.sessionId = makeId();
            this._post(makeEnvelope(KINDS.WELCOME, {
                sessionId: this.sessionId,
                payload: {
                    nonce: payload.nonce,
                    protocolVersion: PROTOCOL_VERSION,
                    capabilities: CAPABILITIES.slice(),
                    editor: this.editorInfo
                }
            }));
            if (this.adapter && typeof this.adapter.onConnected === 'function') this.adapter.onConnected();
            return;
        }

        if (data.kind !== KINDS.REQUEST) return;
        if (!this.isConnected() || origin !== this.parentOrigin || data.sessionId !== this.sessionId) {
            // Requests before/outside the handshake are dropped without a reply.
            return;
        }
        this._handleRequest(data);
    }

    _respond (request, result) {
        // A reload or new handshake must not relabel old asynchronous work.
        if (!this.started || request.sessionId !== this.sessionId) return;
        const fields = {sessionId: request.sessionId, id: request.id, type: request.type};
        if (result.ok) {
            const value = result.value || {};
            const transfer = value.transfer || [];
            const payload = Object.assign({}, value);
            delete payload.transfer;
            this._post(makeEnvelope(KINDS.RESPONSE, Object.assign(fields, {payload: {ok: true, result: payload}})),
                transfer);
        } else {
            this._post(makeEnvelope(KINDS.RESPONSE, Object.assign(fields, {
                payload: {ok: false, error: {code: result.error.code, message: result.error.message}}
            })));
        }
    }

    _handleRequest (request) {
        const methodName = ADAPTER_METHODS[request.type];
        const validated = validateRequest(request.type, request.payload);
        if (!validated.ok) {
            this._respond(request, validated);
            return;
        }
        if (!methodName || !this.adapter || typeof this.adapter[methodName] !== 'function') {
            this._respond(request, {ok: false, error: {code: ERROR_CODES.UNSUPPORTED, message: 'Not supported.'}});
            return;
        }
        let pending;
        try {
            pending = Promise.resolve(this.adapter[methodName](validated.value));
        } catch (e) {
            pending = Promise.reject(e);
        }
        pending.then(
            value => this._respond(request, {ok: true, value: value}),
            err => {
                const code = err && err.code && typeof err.code === 'string' ? err.code : ERROR_CODES.INTERNAL;
                const message = err && err.code && err.message ? String(err.message).slice(0, 200) :
                    'The editor could not do that.';
                if (code === ERROR_CODES.INTERNAL) this.onWarn('Bridge adapter error', err);
                this._respond(request, {ok: false, error: {code: code, message: message}});
            }
        );
    }
}

export {
    BridgeHost as default,
    BridgeError,
    resolveAllowedParentOrigins
};
