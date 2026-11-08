/**
 * Cognimates editor bridge protocol, version 1.
 *
 * KEEP IN SYNC: this file is byte-identical in
 *   CreativeAI/src/bridge/protocol.js
 *   cognimates-gui/src/lib/cognimates-bridge/protocol.js
 * CreativeAI's test suite fails if the two copies differ.
 *
 * The protocol is deliberately small: a fixed list of request types, each with
 * a validated payload. There is no way to send code to evaluate, and nothing
 * the assistant/model returns is executed. Binary data travels as
 * ArrayBuffers (structured clone / transfer), never as script.
 */

export const CHANNEL = 'cognimates-editor-bridge';
export const PROTOCOL_VERSION = 1;

export const KINDS = Object.freeze({
    HELLO: 'hello',
    WELCOME: 'welcome',
    REQUEST: 'request',
    RESPONSE: 'response',
    EVENT: 'event'
});

export const REQUEST_TYPES = Object.freeze({
    GET_CONTEXT: 'getContext',
    IMPORT_ASSET: 'importAsset',
    HIGHLIGHT_BLOCKS: 'highlightBlocks',
    CLEAR_HIGHLIGHTS: 'clearHighlights',
    EXPORT_PROJECT: 'exportProject',
    LOAD_PROJECT: 'loadProject',
    MARK_SAVED: 'markSaved',
    SET_LANGUAGE: 'setLanguage',
    START_TRACE: 'startTrace',
    STOP_TRACE: 'stopTrace'
});

export const EVENT_TYPES = Object.freeze({
    PROJECT_CHANGED: 'projectChanged',
    PROJECT_LOADED: 'projectLoaded',
    TARGET_SELECTED: 'targetSelected'
});

export const ERROR_CODES = Object.freeze({
    BAD_REQUEST: 'bad_request',
    UNKNOWN_TYPE: 'unknown_type',
    NOT_CONNECTED: 'not_connected',
    STALE_REVISION: 'stale_revision',
    UNKNOWN_BLOCK: 'unknown_block',
    UNKNOWN_TARGET: 'unknown_target',
    UNSAVED_CHANGES: 'unsaved_changes',
    TOO_LARGE: 'too_large',
    UNSUPPORTED_MEDIA: 'unsupported_media',
    UNSUPPORTED: 'unsupported',
    IMPORT_FAILED: 'import_failed',
    LOAD_FAILED: 'load_failed',
    RECOVERY_FAILED: 'recovery_failed',
    BUSY: 'busy',
    TIMEOUT: 'timeout',
    INTERNAL: 'internal'
});

export const LIMITS = Object.freeze({
    MAX_MESSAGE_ID_LENGTH: 64,
    MAX_SESSION_ID_LENGTH: 64,
    MAX_TYPE_LENGTH: 32,
    MAX_BLOCK_ID_LENGTH: 128,
    MAX_NAME_LENGTH: 40,
    MAX_TITLE_LENGTH: 100,
    MAX_LOCALE_LENGTH: 12,
    MAX_HIGHLIGHT_IDS: 10,
    MAX_ASSET_BYTES: 2 * 1024 * 1024,
    MAX_PROJECT_BYTES: 30 * 1024 * 1024,
    MAX_CONTEXT_TARGETS: 30,
    MAX_CONTEXT_BLOCKS: 150,
    MAX_CONTEXT_SCRIPTS: 30,
    MAX_CONTEXT_VARIABLES: 20,
    MAX_VALUE_LENGTH: 40,
    MAX_TRACE_EVENTS: 200,
    MAX_TRACE_BLOCKS: 300,
    MAX_TRACE_MS: 20000
});

export const ASSET_KINDS = Object.freeze(['sprite', 'costume', 'backdrop']);
export const ASSET_MIME_TYPES = Object.freeze(['image/png', 'image/jpeg']);

export const CAPABILITIES = Object.freeze([
    REQUEST_TYPES.GET_CONTEXT,
    REQUEST_TYPES.IMPORT_ASSET,
    REQUEST_TYPES.HIGHLIGHT_BLOCKS,
    REQUEST_TYPES.CLEAR_HIGHLIGHTS,
    REQUEST_TYPES.EXPORT_PROJECT,
    REQUEST_TYPES.LOAD_PROJECT,
    REQUEST_TYPES.MARK_SAVED,
    REQUEST_TYPES.SET_LANGUAGE,
    REQUEST_TYPES.START_TRACE,
    REQUEST_TYPES.STOP_TRACE
]);

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

export const isPlainObject = value => {
    if (value === null || typeof value !== 'object') return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
};

export const isArrayBuffer = value => Object.prototype.toString.call(value) === '[object ArrayBuffer]';

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export const isBoundedString = (value, maxLength, minLength) => typeof value === 'string' &&
    value.length >= (typeof minLength === 'number' ? minLength : 1) &&
    value.length <= maxLength &&
    !CONTROL_CHARS.test(value);

export const isNonNegativeInt = value => typeof value === 'number' && Number.isInteger(value) && value >= 0;

/**
 * Normalise an origin string ("https://host:port"); returns null for anything
 * that is not a concrete http(s) origin ("*", "null", paths, other schemes).
 * @param {string} value candidate origin
 * @return {?string} normalised origin
 */
export const normalizeOrigin = value => {
    if (typeof value !== 'string' || !value || value === '*' || value === 'null') return null;
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
        return url.origin;
    } catch (e) {
        return null;
    }
};

/**
 * Parse a comma separated list of origins, dropping invalid entries.
 * @param {string} list e.g. "https://a.example, http://localhost:3001"
 * @return {Array.<string>} normalised origins
 */
export const parseOriginList = list => {
    if (typeof list !== 'string') return [];
    return list.split(',')
        .map(item => normalizeOrigin(item.trim()))
        .filter((item, index, all) => item && all.indexOf(item) === index);
};

export const makeId = () => {
    const bytes = new Uint8Array(12);
    const cryptoObj = (typeof window !== 'undefined' && window.crypto) ||
        (typeof crypto === 'undefined' ? null : crypto);
    if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
        cryptoObj.getRandomValues(bytes);
    } else {
        for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
};

export const makeEnvelope = (kind, fields) => Object.assign({
    channel: CHANNEL,
    version: PROTOCOL_VERSION,
    kind: kind
}, fields);

/**
 * Structural check of a received message. Anything else is ignored silently.
 * @param {*} data event.data
 * @return {boolean} true when this looks like a well-formed bridge envelope
 */
export const isEnvelope = data => {
    if (!isPlainObject(data)) return false;
    if (data.channel !== CHANNEL || data.version !== PROTOCOL_VERSION) return false;
    const kinds = Object.keys(KINDS).map(k => KINDS[k]);
    if (kinds.indexOf(data.kind) === -1) return false;
    if (hasOwn(data, 'id') && !isBoundedString(data.id, LIMITS.MAX_MESSAGE_ID_LENGTH)) return false;
    if (hasOwn(data, 'sessionId') && !isBoundedString(data.sessionId, LIMITS.MAX_SESSION_ID_LENGTH)) return false;
    if (hasOwn(data, 'type') && !isBoundedString(data.type, LIMITS.MAX_TYPE_LENGTH)) return false;
    if (hasOwn(data, 'payload') && data.payload !== null && !isPlainObject(data.payload)) return false;
    if (data.kind !== KINDS.HELLO && data.kind !== KINDS.WELCOME) {
        if (!isBoundedString(data.sessionId, LIMITS.MAX_SESSION_ID_LENGTH)) return false;
    }
    if (data.kind === KINDS.REQUEST || data.kind === KINDS.RESPONSE) {
        if (!isBoundedString(data.id, LIMITS.MAX_MESSAGE_ID_LENGTH)) return false;
    }
    return true;
};

const ok = value => ({ok: true, value: value});
const fail = (code, message) => ({ok: false, error: {code: code, message: message}});

const allowedKeysOnly = (payload, keys) => Object.keys(payload).every(key => keys.indexOf(key) !== -1);

/**
 * Validate and normalise a request payload. Unknown keys are rejected so a
 * newer/older peer cannot smuggle options the receiver does not understand.
 * @param {string} type one of REQUEST_TYPES
 * @param {object} payload request payload
 * @return {{ok: boolean, value: ?object, error: ?object}} validation result
 */
export const validateRequest = (type, payload) => {
    const p = payload === null || typeof payload === 'undefined' ? {} : payload;
    if (!isPlainObject(p)) return fail(ERROR_CODES.BAD_REQUEST, 'Payload must be an object.');
    switch (type) {
    case REQUEST_TYPES.GET_CONTEXT:
        if (!allowedKeysOnly(p, ['includeVariables', 'includeTrace'])) {
            return fail(ERROR_CODES.BAD_REQUEST, 'Unexpected field.');
        }
        return ok({includeVariables: p.includeVariables === true, includeTrace: p.includeTrace === true});
    case REQUEST_TYPES.IMPORT_ASSET: {
        if (!allowedKeysOnly(p, ['kind', 'name', 'mimeType', 'data', 'baseRevision', 'targetId'])) {
            return fail(ERROR_CODES.BAD_REQUEST, 'Unexpected field.');
        }
        if (ASSET_KINDS.indexOf(p.kind) === -1) return fail(ERROR_CODES.BAD_REQUEST, 'Unknown asset kind.');
        if (!isBoundedString(p.name, LIMITS.MAX_NAME_LENGTH)) return fail(ERROR_CODES.BAD_REQUEST, 'Bad name.');
        if (ASSET_MIME_TYPES.indexOf(p.mimeType) === -1) {
            return fail(ERROR_CODES.UNSUPPORTED_MEDIA, 'Only PNG and JPEG images can be imported.');
        }
        if (!isArrayBuffer(p.data)) return fail(ERROR_CODES.BAD_REQUEST, 'Image data must be an ArrayBuffer.');
        if (p.data.byteLength === 0) return fail(ERROR_CODES.BAD_REQUEST, 'Image is empty.');
        if (p.data.byteLength > LIMITS.MAX_ASSET_BYTES) return fail(ERROR_CODES.TOO_LARGE, 'Image is too large.');
        // eslint-disable-next-line no-use-before-define
        const sniffed = sniffImageMime(new Uint8Array(p.data));
        if (sniffed !== p.mimeType) {
            return fail(ERROR_CODES.UNSUPPORTED_MEDIA, 'Image content does not match its type.');
        }
        if (!isNonNegativeInt(p.baseRevision)) return fail(ERROR_CODES.BAD_REQUEST, 'Missing baseRevision.');
        if (p.kind === 'costume' && !isBoundedString(p.targetId, LIMITS.MAX_BLOCK_ID_LENGTH)) {
            return fail(ERROR_CODES.BAD_REQUEST, 'A costume needs a targetId.');
        }
        if (p.kind !== 'costume' && hasOwn(p, 'targetId')) {
            return fail(ERROR_CODES.BAD_REQUEST, 'targetId is only valid for costumes.');
        }
        return ok({
            kind: p.kind,
            name: p.name,
            mimeType: p.mimeType,
            data: p.data,
            baseRevision: p.baseRevision,
            targetId: p.targetId || null
        });
    }
    case REQUEST_TYPES.HIGHLIGHT_BLOCKS: {
        if (!allowedKeysOnly(p, ['blockIds', 'revision'])) return fail(ERROR_CODES.BAD_REQUEST, 'Unexpected field.');
        if (!Array.isArray(p.blockIds) || p.blockIds.length === 0 ||
            p.blockIds.length > LIMITS.MAX_HIGHLIGHT_IDS) {
            return fail(ERROR_CODES.BAD_REQUEST, 'blockIds must list 1-10 ids.');
        }
        if (!p.blockIds.every(id => isBoundedString(id, LIMITS.MAX_BLOCK_ID_LENGTH))) {
            return fail(ERROR_CODES.BAD_REQUEST, 'Bad block id.');
        }
        if (!isNonNegativeInt(p.revision)) return fail(ERROR_CODES.BAD_REQUEST, 'Missing revision.');
        return ok({blockIds: p.blockIds.filter((id, i, all) => all.indexOf(id) === i), revision: p.revision});
    }
    case REQUEST_TYPES.CLEAR_HIGHLIGHTS:
    case REQUEST_TYPES.STOP_TRACE:
        if (Object.keys(p).length !== 0) return fail(ERROR_CODES.BAD_REQUEST, 'No fields expected.');
        return ok({});
    case REQUEST_TYPES.EXPORT_PROJECT:
        if (!allowedKeysOnly(p, ['recovery']) ||
            (hasOwn(p, 'recovery') && typeof p.recovery !== 'boolean')) {
            return fail(ERROR_CODES.BAD_REQUEST, 'Unexpected export option.');
        }
        return ok({recovery: p.recovery === true});
    case REQUEST_TYPES.LOAD_PROJECT: {
        if (!allowedKeysOnly(p, ['data', 'title', 'replaceUnsaved', 'baseRevision'])) {
            return fail(ERROR_CODES.BAD_REQUEST, 'Unexpected field.');
        }
        if (!isArrayBuffer(p.data) || p.data.byteLength === 0) {
            return fail(ERROR_CODES.BAD_REQUEST, 'Project data must be an ArrayBuffer.');
        }
        if (p.data.byteLength > LIMITS.MAX_PROJECT_BYTES) return fail(ERROR_CODES.TOO_LARGE, 'Project is too large.');
        // eslint-disable-next-line no-use-before-define
        if (!isZip(new Uint8Array(p.data))) return fail(ERROR_CODES.UNSUPPORTED_MEDIA, 'Not an sb3 project file.');
        if (hasOwn(p, 'title') && !isBoundedString(p.title, LIMITS.MAX_TITLE_LENGTH, 0)) {
            return fail(ERROR_CODES.BAD_REQUEST, 'Bad title.');
        }
        if (!isNonNegativeInt(p.baseRevision)) return fail(ERROR_CODES.BAD_REQUEST, 'Missing baseRevision.');
        return ok({data: p.data,
            title: p.title || '',
            replaceUnsaved: p.replaceUnsaved === true,
            baseRevision: p.baseRevision});
    }
    case REQUEST_TYPES.MARK_SAVED:
        if (!allowedKeysOnly(p, ['revision']) || !isNonNegativeInt(p.revision)) {
            return fail(ERROR_CODES.BAD_REQUEST, 'Missing revision.');
        }
        return ok({revision: p.revision});
    case REQUEST_TYPES.SET_LANGUAGE:
        if (!allowedKeysOnly(p, ['locale']) || !isBoundedString(p.locale, LIMITS.MAX_LOCALE_LENGTH) ||
            !/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/.test(p.locale)) {
            return fail(ERROR_CODES.BAD_REQUEST, 'Bad locale.');
        }
        return ok({locale: p.locale.toLowerCase()});
    case REQUEST_TYPES.START_TRACE: {
        if (!allowedKeysOnly(p, ['maxDurationMs'])) return fail(ERROR_CODES.BAD_REQUEST, 'Unexpected field.');
        const ms = hasOwn(p, 'maxDurationMs') ? p.maxDurationMs : 15000;
        if (!isNonNegativeInt(ms) || ms < 1000 || ms > LIMITS.MAX_TRACE_MS) {
            return fail(ERROR_CODES.BAD_REQUEST, 'maxDurationMs out of range.');
        }
        return ok({maxDurationMs: ms});
    }
    default:
        return fail(ERROR_CODES.UNKNOWN_TYPE, 'Unknown request type.');
    }
};

/**
 * Detect PNG / JPEG from magic bytes.
 * @param {Uint8Array} bytes file bytes
 * @return {?string} 'image/png', 'image/jpeg' or null
 */
export const sniffImageMime = bytes => {
    if (!bytes || bytes.length < 8) return null;
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
        bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
        return 'image/png';
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    return null;
};

/**
 * @param {Uint8Array} bytes file bytes
 * @return {boolean} true for a zip local-file header (sb3 projects are zips)
 */
export const isZip = bytes => !!bytes && bytes.length >= 4 &&
    bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

/**
 * Read width/height from a PNG IHDR chunk.
 * @param {Uint8Array} bytes PNG bytes
 * @return {?{width: number, height: number}} dimensions or null
 */
export const pngDimensions = bytes => {
    if (sniffImageMime(bytes) !== 'image/png' || bytes.length < 24) return null;
    const read32 = offset => ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) +
        (bytes[offset + 2] << 8) + bytes[offset + 3];
    const width = read32(16);
    const height = read32(20);
    if (!width || !height) return null;
    return {width: width, height: height};
};
