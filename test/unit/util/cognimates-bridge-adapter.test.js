/**
 * Exercises the bridge adapter against a real scratch VM (the sibling
 * cognimates-vm checkout) and the GUI's real reducers.
 */
import {combineReducers, createStore} from 'redux';
import ScratchStorage from 'scratch-storage';
import VM from 'scratch-vm';

import createVmAdapter, {resolveLocale} from '../../../src/lib/cognimates-bridge/vm-adapter';
import {ERROR_CODES, LIMITS, isZip} from '../../../src/lib/cognimates-bridge/protocol';
import projectChanged, {setProjectChanged} from '../../../src/reducers/project-changed';
import projectTitle from '../../../src/reducers/project-title';
import editorTab from '../../../src/reducers/editor-tab';
import locales from '../../../src/reducers/locales';

const makeCreativeLoopProject = require('../../../../cognimates-vm/test/fixtures/creative-loop-project');

const makeStore = vm => createStore(combineReducers({
    locales,
    scratchGui: combineReducers({
        projectChanged,
        projectTitle,
        editorTab,
        vm: (state = vm) => state
    })
}));

const makeTimers = () => {
    const pending = [];
    return {
        setTimeout: fn => {
            pending.push(fn);
            return pending.length;
        },
        clearTimeout: () => {},
        runAll: () => {
            while (pending.length) pending.shift()();
        }
    };
};

// Let real async work (JSZip, VM loading) progress while firing the adapter's
// injected timers, until the promise settles.
const settle = async (promise, timers) => {
    const state = {done: false, value: null, error: null};
    promise.then(v => {
        state.done = true;
        state.value = v;
    }, e => {
        state.done = true;
        state.error = e;
    });
    for (let i = 0; i < 200; i++) {
        if (state.done) break;
        await new Promise(resolve => setTimeout(resolve, 5));
        timers.runAll();
    }
    if (state.error) throw state.error;
    return state.value;
};

const setup = async (options = {}) => {
    const vm = new VM();
    const storage = new ScratchStorage();
    vm.attachStorage(storage);
    await vm.loadProject(makeCreativeLoopProject(storage.getDefaultAssetId(storage.AssetType.ImageVector)));
    const store = makeStore(vm);
    const timers = makeTimers();
    const adapter = createVmAdapter(Object.assign({vm,
        store,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout}, options));
    vm.setEditingTarget(vm.runtime.getSpriteTargetByName('Creature').id);
    return {vm, store, adapter, timers};
};

const expectBridgeError = async (promiseOrFn, code) => {
    let error = null;
    try {
        await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
    } catch (e) {
        error = e;
    }
    expect(error).not.toBeNull();
    expect(error.code).toBe(code);
};

describe('Cognimates bridge adapter (real VM)', () => {
    test('an image decoded after a project switch cannot import into the new project', async () => {
        let finish;
        const {adapter, vm} = await setup({makeCostume: () => new Promise(resolve => {
            finish = resolve;
        })});
        const addSprite = jest.spyOn(vm, 'addSprite');
        const pending = adapter.importAsset({kind: 'sprite',
            name: 'Late',
            data: new ArrayBuffer(1),
            mimeType: 'image/png',
            baseRevision: adapter.getRevision()});
        await vm.loadProject(vm.toJSON());
        finish({name: 'Late'});
        await expectBridgeError(pending, ERROR_CODES.STALE_REVISION);
        expect(addSprite).not.toHaveBeenCalled();
    });

    test('a failure after the VM clears targets restores the complete previous project', async () => {
        const {adapter, vm, store} = await setup();
        const exported = await adapter.exportProject();
        vm.renameSprite(vm.editingTarget.id, 'Keep my work');
        store.dispatch(setProjectChanged());
        jest.spyOn(vm, 'loadProject').mockImplementationOnce(async (data, beforeLoad) => {
            beforeLoad();
            vm.clear();
            throw new Error('Synthetic late asset failure');
        });
        await expectBridgeError(adapter.loadProject({data: exported.data,
            title: 'Replacement',
            replaceUnsaved: true,
            baseRevision: adapter.getRevision()}), ERROR_CODES.LOAD_FAILED);
        expect(vm.runtime.getSpriteTargetByName('Keep my work').blocks.getBlock('moveBlock')).toBeTruthy();
        expect(store.getState().scratchGui.projectChanged).toBe(true);
    });

    test('edits while a load checkpoint is being saved cancel replacement', async () => {
        const {adapter, vm} = await setup();
        const exported = await adapter.exportProject();
        let finish;
        jest.spyOn(vm, 'saveProjectSb3').mockImplementationOnce(() => new Promise(resolve => {
            finish = resolve;
        }));
        const pending = adapter.loadProject({data: exported.data,
            title: 'Old',
            replaceUnsaved: true,
            baseRevision: adapter.getRevision()});
        vm.renameSprite(vm.editingTarget.id, 'New edit');
        finish(exported.data);
        await expectBridgeError(pending, ERROR_CODES.STALE_REVISION);
        expect(vm.runtime.getSpriteTargetByName('New edit')).toBeTruthy();
    });

    test('a failed rollback retains a separate downloadable complete checkpoint', async () => {
        const {adapter, vm} = await setup();
        const input = await adapter.exportProject();
        const loader = jest.spyOn(vm, 'loadProject')
            .mockImplementationOnce(async (data, beforeLoad) => {
                beforeLoad();
                vm.clear();
                throw new Error('Failed replacement');
            })
            .mockImplementationOnce(async () => { throw new Error('Failed rollback'); });
        await expectBridgeError(adapter.loadProject({data: input.data, replaceUnsaved: true,
            baseRevision: adapter.getRevision()}), ERROR_CODES.RECOVERY_FAILED);
        const backup = await adapter.exportProject({recovery: true});
        expect(backup.recovery).toBe(true);
        loader.mockRestore();
        await vm.loadProject(backup.data);
        expect(vm.runtime.getSpriteTargetByName('Creature').blocks.getBlock('moveBlock')).toBeTruthy();
        expect((await adapter.exportProject()).recovery).toBe(false);
    });

    test('editing code invalidates a previous run recording', async () => {
        const {adapter, vm} = await setup();
        adapter.startTrace({maxDurationMs: 5000});
        vm.greenFlag();
        vm.runtime._step();
        expect(adapter.stopTrace().trace).toBeTruthy();
        vm.renameSprite(vm.editingTarget.id, 'Changed');
        expect(adapter.getContext({includeTrace: true}).trace).toBeNull();
        expect(adapter.stopTrace().trace).toBeNull();
    });

    test('context is a bounded static snapshot of the selected sprite', async () => {
        const {adapter, vm} = await setup();
        const context = adapter.getContext({includeVariables: false, includeTrace: false});
        expect(context.analysis).toBe('static');
        expect(context.editingTarget.name).toBe('Creature');
        expect(context.scripts.map(s => s.hatOpcode).sort())
            .toEqual(['event_whenflagclicked', 'event_whenthisspriteclicked']);
        const move = context.blocks.find(b => b.id === 'moveBlock');
        expect(move).toMatchObject({opcode: 'motion_movesteps', parent: 'flagHat', next: 'turnBlock'});
        expect(move.inputs.STEPS).toEqual({literal: '10'});
        expect(context.blocks.every(b => vm.editingTarget.blocks.getBlock(b.id))).toBe(true);
        expect(context.variables).toBeUndefined();
        expect(context.trace).toBeUndefined();

        const withVars = adapter.getContext({includeVariables: true, includeTrace: false});
        expect(withVars.variables).toEqual([
            {id: 'surpriseVar', name: 'surprise', type: '', scope: 'sprite', value: '0'}
        ]);
    });

    test('context truncates a very long script at the block limit', async () => {
        const {adapter, vm} = await setup();
        const target = vm.editingTarget;
        const n = LIMITS.MAX_CONTEXT_BLOCKS + 20;
        for (let i = 0; i < n; i++) {
            target.blocks.createBlock({id: `long${i}`,
                opcode: 'motion_ifonedgebounce',
                next: i < n - 1 ? `long${i + 1}` : null,
                parent: i ? `long${i - 1}` : null,
                inputs: {},
                fields: {},
                shadow: false,
                topLevel: i === 0,
                x: 0,
                y: 0});
        }
        const context = adapter.getContext({});
        expect(context.blocks.length).toBe(LIMITS.MAX_CONTEXT_BLOCKS);
        expect(context.truncated.blocks).toBe(true);
    });

    test('context truncates projects with very many scripts at the script limit', async () => {
        const {adapter, vm} = await setup();
        for (let i = 0; i < LIMITS.MAX_CONTEXT_SCRIPTS + 5; i++) {
            vm.editingTarget.blocks.createBlock({id: `hat${i}`,
                opcode: 'event_whenflagclicked',
                next: null,
                parent: null,
                inputs: {},
                fields: {},
                shadow: false,
                topLevel: true,
                x: 0,
                y: 0});
        }
        const context = adapter.getContext({});
        expect(context.scripts.length).toBe(LIMITS.MAX_CONTEXT_SCRIPTS);
        expect(context.truncated.blocks).toBe(true);
    });

    test('highlighting existing blocks at the current revision glows them, then clears', async () => {
        const {adapter, vm, timers} = await setup();
        const glows = [];
        vm.on('BLOCK_GLOW_ON', d => glows.push(['block+', d.id]));
        vm.on('SCRIPT_GLOW_ON', d => glows.push(['script+', d.id]));
        vm.on('BLOCK_GLOW_OFF', d => glows.push(['block-', d.id]));
        const focus = jest.fn();
        vm.on('COGNIMATES_FOCUS_BLOCK', focus);
        const revision = adapter.getRevision();
        const result = adapter.highlightBlocks({blockIds: ['turnBlock'], revision});
        expect(result).toMatchObject({highlighted: ['turnBlock'], revision});
        expect(glows).toEqual([['block+', 'turnBlock'], ['script+', 'flagHat']]);
        expect(focus).toHaveBeenCalledWith({id: 'turnBlock'});
        timers.runAll();
        expect(glows).toContainEqual(['block-', 'turnBlock']);
    });

    test('unknown block ids and stale revisions are rejected without glowing anything', async () => {
        const {adapter, vm} = await setup();
        const glow = jest.fn();
        vm.on('BLOCK_GLOW_ON', glow);
        const revision = adapter.getRevision();
        await expectBridgeError(() => adapter.highlightBlocks({blockIds: ['moveBlock', 'madeUpId'], revision}),
            ERROR_CODES.UNKNOWN_BLOCK);
        vm.renameSprite(vm.editingTarget.id, 'Creature 2'); // a real edit bumps the revision
        expect(adapter.getRevision()).toBeGreaterThan(revision);
        await expectBridgeError(() => adapter.highlightBlocks({blockIds: ['moveBlock'], revision}),
            ERROR_CODES.STALE_REVISION);
        expect(glow).not.toHaveBeenCalled();
    });

    test('highlighting a block on another sprite switches to that sprite', async () => {
        const {adapter, vm} = await setup();
        vm.setEditingTarget(vm.runtime.getTargetForStage().id);
        adapter.highlightBlocks({blockIds: ['sayBlock'], revision: adapter.getRevision()});
        expect(vm.editingTarget.getName()).toBe('Creature');
    });

    test('stale or invalid imports are rejected before touching the project', async () => {
        const {adapter, vm} = await setup();
        const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).buffer;
        const before = vm.runtime.targets.length;
        await expectBridgeError(() => adapter.importAsset({kind: 'sprite',
            name: 'x',
            mimeType: 'image/png',
            data: png,
            baseRevision: adapter.getRevision() + 5}), ERROR_CODES.STALE_REVISION);
        await expectBridgeError(() => adapter.importAsset({kind: 'costume',
            name: 'x',
            mimeType: 'image/png',
            data: png,
            baseRevision: adapter.getRevision(),
            targetId: vm.runtime.getTargetForStage().id}),
        ERROR_CODES.UNKNOWN_TARGET);
        expect(vm.runtime.targets.length).toBe(before);
    });

    test('export produces a complete sb3 that reloads; unsaved work is never replaced silently', async () => {
        const {adapter, vm, store, timers} = await setup();
        const exported = await adapter.exportProject();
        expect(isZip(new Uint8Array(exported.data))).toBe(true);
        expect(exported.transfer).toEqual([exported.data]);

        store.dispatch(setProjectChanged());
        vm.renameSprite(vm.editingTarget.id, 'Changed Name');
        await expectBridgeError(adapter.loadProject({data: exported.data, title: 'Old', replaceUnsaved: false}),
            ERROR_CODES.UNSAVED_CHANGES);
        expect(vm.runtime.getSpriteTargetByName('Changed Name')).toBeTruthy();

        const result = await settle(adapter.loadProject({data: exported.data, title: 'Old', replaceUnsaved: true}),
            timers);
        expect(result.projectChanged).toBe(false);
        expect(store.getState().scratchGui.projectChanged).toBe(false);
        expect(store.getState().scratchGui.projectTitle).toBe('Old');
        expect(vm.runtime.getSpriteTargetByName('Creature')).toBeTruthy();
        expect(vm.runtime.getSpriteTargetByName('Creature').blocks.getBlock('flagHat')).toBeTruthy();
    });

    test('a corrupt project file is refused and the current project stays open', async () => {
        const {adapter, vm} = await setup();
        const bogus = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5]).buffer;
        await expectBridgeError(adapter.loadProject({data: bogus, title: '', replaceUnsaved: true}),
            ERROR_CODES.LOAD_FAILED);
        expect(vm.runtime.getSpriteTargetByName('Creature')).toBeTruthy();
    });

    test('markSaved only clears the unsaved flag for the revision that was saved', async () => {
        const {adapter, vm, store} = await setup();
        store.dispatch(setProjectChanged());
        const saved = adapter.getRevision();
        vm.renameSprite(vm.editingTarget.id, 'Edited after export');
        expect(adapter.markSaved({revision: saved}).projectChanged).toBe(true);
        expect(adapter.markSaved({revision: adapter.getRevision()}).projectChanged).toBe(false);
        expect(store.getState().scratchGui.projectChanged).toBe(false);
    });

    test('language changes in place without touching the project', async () => {
        const {adapter, vm, store} = await setup();
        const revision = adapter.getRevision();
        const result = adapter.setLanguage({locale: 'es'});
        expect(result.locale).toBe('es');
        expect(store.getState().locales.locale).toBe('es');
        expect(adapter.getRevision()).toBe(revision);
        expect(vm.runtime.getSpriteTargetByName('Creature').blocks.getBlock('moveBlock')).toBeTruthy();
        await expectBridgeError(() => adapter.setLanguage({locale: 'tlh'}), ERROR_CODES.UNSUPPORTED);
        expect(resolveLocale('zh', {'zh-cn': {}, 'en': {}})).toBe('zh-cn');
        expect(resolveLocale('pt', {'pt-br': {}, 'pt': {}})).toBe('pt');
        expect(resolveLocale('pt', {'pt-br': {}})).toBe('pt-br');
        expect(resolveLocale('xx', {en: {}})).toBeNull();
    });

    test('an opt-in trace reports what actually ran', async () => {
        const {adapter, vm} = await setup();
        expect(adapter.getContext({includeTrace: true}).trace).toBeNull();
        adapter.startTrace({maxDurationMs: 5000});
        vm.greenFlag();
        vm.runtime.currentStepTime = 1000 / 30;
        vm.runtime._step();
        vm.runtime._step();
        const stopped = adapter.stopTrace();
        const ran = stopped.trace.executedBlocks.map(b => b.blockId);
        expect(ran).toEqual(expect.arrayContaining(['flagHat', 'moveBlock', 'turnBlock']));
        expect(ran).not.toContain('sayBlock');
        expect(adapter.getContext({includeTrace: true}).trace.executedBlocks.length).toBe(ran.length);
    });
});
