import BridgeHost, {BridgeError, resolveAllowedParentOrigins} from '../../../src/lib/cognimates-bridge/bridge-host';
import {CHANNEL, ERROR_CODES, KINDS, PROTOCOL_VERSION} from '../../../src/lib/cognimates-bridge/protocol';

const PARENT_ORIGIN = 'https://copilot.example';

const makeWindows = () => {
    const listeners = [];
    const posted = [];
    const parent = {
        posted,
        postMessage: jest.fn((msg, origin, transfer) => {
            posted.push({msg, origin, transfer});
        })
    };
    const win = {
        parent,
        addEventListener: (type, fn) => listeners.push(fn),
        removeEventListener: (type, fn) => {
            const i = listeners.indexOf(fn);
            if (i !== -1) listeners.splice(i, 1);
        },
        listenerCount: () => listeners.length
    };
    return {win, parent, listeners};
};

const envelope = (kind, fields) => Object.assign({channel: CHANNEL, version: PROTOCOL_VERSION, kind}, fields);
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

const setup = adapter => {
    const {win, parent} = makeWindows();
    const host = new BridgeHost({win, allowedOrigins: [PARENT_ORIGIN], adapter: adapter || {}});
    expect(host.start()).toBe(true);
    const send = (data, overrides) => host.handleMessage(Object.assign({source: parent, origin: PARENT_ORIGIN, data},
        overrides));
    const handshake = () => {
        send(envelope(KINDS.HELLO, {payload: {nonce: 'n1', protocolVersion: PROTOCOL_VERSION}}));
        return parent.posted[parent.posted.length - 1].msg.sessionId;
    };
    return {host, win, parent, send, handshake};
};

describe('Cognimates bridge host', () => {
    test('a delayed response is discarded after a new handshake or stop', async () => {
        let finish;
        const {host, parent, send, handshake} = setup({getContext: () => new Promise(resolve => {
            finish = resolve;
        })});
        const sessionId = handshake();
        send(envelope(KINDS.REQUEST, {sessionId, id: 'old', type: 'getContext', payload: {}}));
        handshake();
        finish({revision: 9});
        await flush();
        expect(parent.posted.filter(item => item.msg.kind === KINDS.RESPONSE)).toHaveLength(0);
        const fresh = host.sessionId;
        send(envelope(KINDS.REQUEST, {sessionId: fresh, id: 'stopped', type: 'getContext', payload: {}}));
        host.stop();
        finish({revision: 10});
        await flush();
        expect(parent.posted.filter(item => item.msg.kind === KINDS.RESPONSE)).toHaveLength(0);
    });

    test('does not start when the editor is not embedded', () => {
        const win = {addEventListener: jest.fn()};
        win.parent = win;
        const host = new BridgeHost({win, allowedOrigins: [PARENT_ORIGIN], adapter: {}});
        expect(host.start()).toBe(false);
        expect(win.addEventListener).not.toHaveBeenCalled();
    });

    test('handshake replies only to the exact allowed origin', () => {
        const {parent, send} = setup();
        send(envelope(KINDS.HELLO, {payload: {nonce: 'abc', protocolVersion: PROTOCOL_VERSION}}));
        expect(parent.posted).toHaveLength(1);
        const {msg, origin} = parent.posted[0];
        expect(origin).toBe(PARENT_ORIGIN);
        expect(msg.kind).toBe(KINDS.WELCOME);
        expect(msg.payload.nonce).toBe('abc');
        expect(msg.payload.capabilities).toContain('highlightBlocks');
        expect(msg.payload.capabilities).not.toContain('eval');
        expect(typeof msg.sessionId).toBe('string');
    });

    test('ignores unexpected origins, foreign windows and malformed data without replying', () => {
        const {parent, send} = setup();
        const hello = envelope(KINDS.HELLO, {payload: {nonce: 'abc', protocolVersion: PROTOCOL_VERSION}});
        send(hello, {origin: 'https://evil.example'});
        send(hello, {origin: 'null'});
        send(hello, {source: {postMessage: jest.fn()}});
        send({channel: CHANNEL, version: 99, kind: KINDS.HELLO, payload: {nonce: 'x'}});
        send('not an object');
        send(envelope(KINDS.HELLO, {payload: {nonce: 'abc', protocolVersion: 2}}));
        expect(parent.posted).toHaveLength(0);
    });

    test('requests before the handshake or with a wrong session are dropped', () => {
        const adapter = {getContext: jest.fn(() => ({revision: 1}))};
        const {parent, send, handshake} = setup(adapter);
        send(envelope(KINDS.REQUEST, {sessionId: 'guess', id: 'r1', type: 'getContext', payload: {}}));
        expect(parent.posted).toHaveLength(0);
        const sessionId = handshake();
        send(envelope(KINDS.REQUEST, {sessionId: 'other', id: 'r2', type: 'getContext', payload: {}}));
        send(envelope(KINDS.REQUEST, {sessionId, id: 'r3', type: 'getContext', payload: {}}),
            {origin: 'https://evil.example'});
        expect(adapter.getContext).not.toHaveBeenCalled();
    });

    test('valid requests reach the adapter and the response echoes the request id', async () => {
        const adapter = {getContext: jest.fn(() => ({revision: 7}))};
        const {parent, send, handshake} = setup(adapter);
        const sessionId = handshake();
        send(envelope(KINDS.REQUEST, {sessionId, id: 'req-1', type: 'getContext', payload: {includeVariables: true}}));
        await flush();
        expect(adapter.getContext).toHaveBeenCalledWith({includeVariables: true, includeTrace: false});
        const {msg, origin} = parent.posted[parent.posted.length - 1];
        expect(origin).toBe(PARENT_ORIGIN);
        expect(msg).toMatchObject({kind: KINDS.RESPONSE,
            id: 'req-1',
            sessionId,
            payload: {ok: true, result: {revision: 7}}});
    });

    test('schema violations and unknown types are rejected before the adapter runs', async () => {
        const adapter = {highlightBlocks: jest.fn(), getContext: jest.fn()};
        const {parent, send, handshake} = setup(adapter);
        const sessionId = handshake();
        send(envelope(KINDS.REQUEST, {sessionId, id: 'a', type: 'highlightBlocks', payload: {blockIds: []}}));
        send(envelope(KINDS.REQUEST, {sessionId, id: 'b', type: 'evaluate', payload: {code: 'alert(1)'}}));
        send(envelope(KINDS.REQUEST, {sessionId, id: 'c', type: 'getContext', payload: {script: 'x'}}));
        send(envelope(KINDS.REQUEST, {sessionId,
            id: 'd',
            type: 'importAsset',
            payload: {
                kind: 'sprite',
                name: 'x',
                mimeType: 'image/png',
                data: new Uint8Array([1, 2, 3]).buffer,
                baseRevision: 0
            }}));
        await flush();
        expect(adapter.highlightBlocks).not.toHaveBeenCalled();
        expect(adapter.getContext).not.toHaveBeenCalled();
        const errors = parent.posted.slice(1).map(p => [p.msg.id, p.msg.payload.error.code]);
        expect(errors).toEqual([
            ['a', ERROR_CODES.BAD_REQUEST],
            ['b', ERROR_CODES.UNKNOWN_TYPE],
            ['c', ERROR_CODES.BAD_REQUEST],
            ['d', ERROR_CODES.UNSUPPORTED_MEDIA]
        ]);
    });

    test('adapter errors keep their protocol code; unexpected errors are generic', async () => {
        const adapter = {
            highlightBlocks: () => {
                throw new BridgeError(ERROR_CODES.STALE_REVISION, 'changed');
            },
            getContext: () => {
                throw new Error('secret internal detail');
            }
        };
        const {parent, send, handshake} = setup(adapter);
        const sessionId = handshake();
        send(envelope(KINDS.REQUEST, {sessionId,
            id: 'h',
            type: 'highlightBlocks',
            payload: {blockIds: ['a'], revision: 1}}));
        send(envelope(KINDS.REQUEST, {sessionId, id: 'g', type: 'getContext', payload: {}}));
        await flush();
        const [h, g] = parent.posted.slice(1).map(p => p.msg.payload);
        expect(h.error).toEqual({code: ERROR_CODES.STALE_REVISION, message: 'changed'});
        expect(g.error.code).toBe(ERROR_CODES.INTERNAL);
        expect(g.error.message).not.toContain('secret');
    });

    test('binary results are transferred, not copied into the payload metadata', async () => {
        const data = new ArrayBuffer(8);
        const adapter = {exportProject: () => Promise.resolve({data, byteLength: 8, revision: 3, transfer: [data]})};
        const {parent, send, handshake} = setup(adapter);
        const sessionId = handshake();
        send(envelope(KINDS.REQUEST, {sessionId, id: 'e', type: 'exportProject', payload: {}}));
        await flush();
        const last = parent.posted[parent.posted.length - 1];
        expect(last.transfer).toEqual([data]);
        expect(last.msg.payload.result.transfer).toBeUndefined();
        expect(last.msg.payload.result.data).toBe(data);
    });

    test('events flow only after the handshake and stop() removes the listener', () => {
        let emit;
        const adapter = {subscribe: fn => {
            emit = fn;
            return () => {
                emit = null;
            };
        }};
        const {host, win, parent, handshake} = setup(adapter);
        emit('projectChanged', {revision: 1});
        expect(parent.posted).toHaveLength(0);
        handshake();
        emit('projectChanged', {revision: 2});
        expect(parent.posted[1].msg).toMatchObject({kind: KINDS.EVENT, type: 'projectChanged', payload: {revision: 2}});
        host.stop();
        expect(win.listenerCount()).toBe(0);
        expect(emit).toBeNull();
    });

    test('allowed origins never include wildcards and always include the editor itself', () => {
        expect(resolveAllowedParentOrigins('*, null, javascript:alert(1), https://a.example/path, http://localhost:3001',
            'https://editor.example')).toEqual(['https://a.example', 'http://localhost:3001', 'https://editor.example']);
    });
});
