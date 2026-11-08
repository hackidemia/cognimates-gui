/**
 * Adapter between the bridge host and the running editor (VM + redux store).
 * Every method corresponds to one allowed bridge request; payloads have
 * already been validated by protocol.validateRequest.
 *
 * Nothing here edits the child's scripts. Imports add a sprite, costume or
 * backdrop (which the child can then edit, rename or delete as usual);
 * highlighting only changes glow/scroll state.
 */
import {costumeUpload} from '../file-uploader';
import randomizeSpritePosition from '../randomize-sprite-position';
import {selectLocale} from '../../reducers/locales';
import {setProjectChanged, setProjectUnchanged} from '../../reducers/project-changed';
import {setProjectTitle} from '../../reducers/project-title';
import {activateTab, BLOCKS_TAB_INDEX} from '../../reducers/editor-tab';
import {BridgeError} from './bridge-host';
import {buildProjectContext, describeTrace, locateBlocks} from './project-context';
import {ERROR_CODES, EVENT_TYPES, LIMITS, pngDimensions} from './protocol';

const HIGHLIGHT_MS = 8000;
const EVENT_THROTTLE_MS = 250;

// Map the assistant's language codes onto editor locales when they differ.
const LOCALE_ALIASES = {
    zh: ['zh-cn', 'zh-tw'],
    pt: ['pt-br', 'pt']
};

const resolveLocale = (requested, messagesByLocale) => {
    if (!messagesByLocale) return null;
    if (messagesByLocale[requested]) return requested;
    const base = requested.split('-')[0];
    const aliases = LOCALE_ALIASES[base] || [];
    for (let i = 0; i < aliases.length; i++) {
        if (messagesByLocale[aliases[i]]) return aliases[i];
    }
    if (messagesByLocale[base]) return base;
    const prefixed = Object.keys(messagesByLocale).filter(key => key.indexOf(`${base}-`) === 0);
    return prefixed.length ? prefixed[0] : null;
};

/**
 * Turn validated image bytes into a VM costume object using the editor's own
 * upload path (BitmapAdapter resizing, storage asset + md5).
 * @param {object} storage scratch-storage instance
 * @param {ArrayBuffer} data image bytes
 * @param {string} mimeType image/png or image/jpeg
 * @param {string} name costume name
 * @return {Promise.<object>} VM costume
 */
const makeCostume = (storage, data, mimeType, name) => new Promise((resolve, reject) => {
    costumeUpload(data, mimeType, storage, costumes => {
        const costume = costumes && costumes[0];
        if (!costume) {
            reject(new BridgeError(ERROR_CODES.IMPORT_FAILED, 'The picture could not be read.'));
            return;
        }
        costume.name = name;
        // Bitmaps in Scratch 3 are resolution 2. Put the rotation centre in the
        // middle of the imported picture so it spins/flips around its centre.
        const size = pngDimensions(costume.asset.data);
        if (size) {
            costume.bitmapResolution = 2;
            costume.rotationCenterX = size.width / 2;
            costume.rotationCenterY = size.height / 2;
        }
        resolve(costume);
    }, () => reject(new BridgeError(ERROR_CODES.IMPORT_FAILED, 'The picture could not be read.')));
});

const arrayBufferOf = value => {
    if (value instanceof ArrayBuffer) return Promise.resolve(value);
    if (value && typeof value.arrayBuffer === 'function') return value.arrayBuffer();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsArrayBuffer(value);
    });
};

/**
 * @param {object} options adapter options
 * @param {object} options.vm scratch VM
 * @param {object} options.store redux store ({getState, dispatch})
 * @param {function} [options.setTimeout] injectable timer (tests)
 * @param {function} [options.clearTimeout] injectable timer (tests)
 * @return {object} adapter
 */
const createVmAdapter = options => {
    const vm = options.vm;
    const store = options.store;
    const setTimer = options.setTimeout || setTimeout;
    const clearTimer = options.clearTimeout || clearTimeout;
    const listeners = [];
    let revision = 0;
    let projectEpoch = 0;
    let lastTrace = null;
    let traceRevision = null;
    let busy = false;
    let recoveryCheckpoint = null;
    let selectedTargetId = null;
    let glowing = [];
    let glowTimer = null;
    let eventTimer = null;

    const getState = () => store.getState();
    const projectChanged = () => !!getState().scratchGui.projectChanged;

    const notify = (type, payload) => {
        listeners.slice().forEach(fn => fn(type, payload));
    };
    const scheduleChangedEvent = () => {
        if (eventTimer) return;
        eventTimer = setTimer(() => {
            eventTimer = null;
            notify(EVENT_TYPES.PROJECT_CHANGED, {revision: revision, projectChanged: projectChanged()});
        }, EVENT_THROTTLE_MS);
    };
    const onProjectChanged = () => {
        revision++;
        lastTrace = null;
        traceRevision = null;
        if (typeof vm.stopExecutionTrace === 'function') vm.stopExecutionTrace();
        scheduleChangedEvent();
    };
    const onProjectLoaded = () => {
        revision++;
        projectEpoch++;
        lastTrace = null;
        traceRevision = null;
        glowing = [];
        notify(EVENT_TYPES.PROJECT_LOADED, {revision: revision, projectEpoch: projectEpoch});
    };
    const onTargetsUpdate = () => {
        const id = vm.editingTarget ? vm.editingTarget.id : null;
        if (id !== selectedTargetId) {
            selectedTargetId = id;
            notify(EVENT_TYPES.TARGET_SELECTED, {targetId: id});
        }
    };
    vm.on('PROJECT_CHANGED', onProjectChanged);
    vm.on('targetsUpdate', onTargetsUpdate);
    vm.runtime.on('PROJECT_LOADED', onProjectLoaded);

    const requireRevision = given => {
        if (given !== revision) {
            throw new BridgeError(ERROR_CODES.STALE_REVISION,
                'The project changed since this was prepared. Please try again.');
        }
    };
    const requireIdle = () => {
        if (busy) throw new BridgeError(ERROR_CODES.BUSY, 'Please wait for the project to finish opening.');
    };
    const withMutation = async operation => {
        requireIdle();
        busy = true;
        if (options.onBusy) options.onBusy(true);
        try {
            return await operation();
        } finally {
            busy = false;
            if (options.onBusy) options.onBusy(false);
        }
    };

    const clearHighlights = () => {
        if (glowTimer) clearTimer(glowTimer);
        glowTimer = null;
        glowing.forEach(item => {
            vm.runtime.glowBlock(item.blockId, false);
            if (item.scriptId) vm.runtime.glowScript(item.scriptId, false);
        });
        glowing = [];
        return {cleared: true};
    };

    return {
        subscribe (fn) {
            listeners.push(fn);
            return () => {
                const i = listeners.indexOf(fn);
                if (i !== -1) listeners.splice(i, 1);
            };
        },

        getRevision () {
            return revision;
        },

        dispose () {
            vm.removeListener('PROJECT_CHANGED', onProjectChanged);
            vm.removeListener('targetsUpdate', onTargetsUpdate);
            vm.runtime.removeListener('PROJECT_LOADED', onProjectLoaded);
            if (eventTimer) clearTimer(eventTimer);
            clearHighlights();
            listeners.length = 0;
        },

        getContext (request) {
            const running = typeof vm.getExecutionTraceSummary === 'function' && vm.getExecutionTraceSummary();
            const summary = traceRevision === revision ? (running || lastTrace) : null;
            const traceSummary = summary ? Object.assign({}, summary, {revision: traceRevision}) : null;
            return Object.assign(buildProjectContext({
                vm: vm,
                revision: revision,
                projectChanged: projectChanged(),
                title: getState().scratchGui.projectTitle,
                includeVariables: request.includeVariables,
                includeTrace: request.includeTrace,
                traceSummary: traceSummary
            }), {projectEpoch: projectEpoch});
        },

        importAsset (request) {
            requireIdle();
            requireRevision(request.baseRevision);
            const storage = vm.runtime.storage;
            let target = null;
            if (request.kind === 'costume') {
                target = vm.runtime.getTargetById(request.targetId);
                if (!target || !target.isOriginal || target.isStage) {
                    throw new BridgeError(ERROR_CODES.UNKNOWN_TARGET, 'That sprite is not in the project any more.');
                }
            }
            return (options.makeCostume || makeCostume)(storage, request.data, request.mimeType, request.name)
                .then(costume => {
                    requireRevision(request.baseRevision);
                    return withMutation(() => {
                        if (request.kind === 'sprite') {
                            const sprite = {
                                name: request.name,
                                isStage: false,
                                x: 0,
                                y: 0,
                                visible: true,
                                size: 100,
                                rotationStyle: 'all around',
                                direction: 90,
                                draggable: false,
                                currentCostume: 0,
                                blocks: {},
                                variables: {},
                                costumes: [costume],
                                sounds: []
                            };
                            randomizeSpritePosition(sprite);
                            return vm.addSprite(JSON.stringify(sprite)).then(() => {
                                store.dispatch(activateTab(BLOCKS_TAB_INDEX));
                                const added = vm.editingTarget;
                                return {kind: 'sprite',
                                    targetId: added.id,
                                    targetName: added.getName(),
                                    costumeName: added.getCostumes()[0].name};
                            });
                        }
                        if (request.kind === 'costume') {
                            return vm.addCostume(costume.md5, costume, target.id).then(() => ({
                                kind: 'costume',
                                targetId: target.id,
                                targetName: target.getName(),
                                costumeName: target.getCostumes()[target.getCostumes().length - 1].name
                            }));
                        }
                        return vm.addBackdrop(costume.md5, costume).then(() => {
                            const stage = vm.runtime.getTargetForStage();
                            return {kind: 'backdrop',
                                targetId: stage.id,
                                targetName: stage.getName(),
                                costumeName: stage.getCostumes()[stage.getCostumes().length - 1].name};
                        });
                    });
                })
                .then(result => Object.assign(result, {revision: revision}), err => {
                    if (err instanceof BridgeError) throw err;
                    throw new BridgeError(ERROR_CODES.IMPORT_FAILED, 'The picture could not be added to the project.');
                });
        },

        highlightBlocks (request) {
            requireRevision(request.revision);
            const located = locateBlocks(vm.runtime, request.blockIds);
            const missing = request.blockIds.filter(id => !located[id]);
            if (missing.length) {
                throw new BridgeError(ERROR_CODES.UNKNOWN_BLOCK, 'Some of those blocks are not in the project.');
            }
            const targetId = located[request.blockIds[0]];
            const ids = request.blockIds.filter(id => located[id] === targetId);
            clearHighlights();
            if (!vm.editingTarget || vm.editingTarget.id !== targetId) vm.setEditingTarget(targetId);
            store.dispatch(activateTab(BLOCKS_TAB_INDEX));
            const target = vm.runtime.getTargetById(targetId);
            ids.forEach(id => {
                const scriptId = target.blocks.getTopLevelScript(id);
                vm.runtime.glowBlock(id, true);
                if (scriptId) vm.runtime.glowScript(scriptId, true);
                glowing.push({blockId: id, scriptId: scriptId});
            });
            vm.emit('COGNIMATES_FOCUS_BLOCK', {id: ids[0]});
            glowTimer = setTimer(clearHighlights, HIGHLIGHT_MS);
            return {highlighted: ids, targetId: targetId, revision: revision};
        },

        clearHighlights () {
            return clearHighlights();
        },

        exportProject (request = {}) {
            requireIdle();
            const exportedRevision = revision;
            const exportedEpoch = projectEpoch;
            const backup = request.recovery && recoveryCheckpoint;
            const title = backup ? backup.title : getState().scratchGui.projectTitle || '';
            const output = backup ? backup.data.slice(0) : vm.saveProjectSb3('arraybuffer');
            return Promise.resolve(output)
                .then(arrayBufferOf)
                .then(data => {
                    if (data.byteLength > LIMITS.MAX_PROJECT_BYTES) {
                        throw new BridgeError(ERROR_CODES.TOO_LARGE, 'This project is too big to save here.');
                    }
                    return {
                        data: data,
                        byteLength: data.byteLength,
                        revision: exportedRevision,
                        title: title,
                        projectEpoch: exportedEpoch,
                        recovery: !!backup,
                        projectChanged: projectChanged(),
                        transfer: [data]
                    };
                });
        },

        loadProject (request) {
            if (typeof request.baseRevision === 'number') requireRevision(request.baseRevision);
            if (projectChanged() && !request.replaceUnsaved) {
                return Promise.reject(new BridgeError(ERROR_CODES.UNSAVED_CHANGES,
                    'The open project has unsaved changes.'));
            }
            return withMutation(async () => {
                const expected = revision;
                const title = getState().scratchGui.projectTitle;
                const changed = projectChanged();
                vm.stopAll();
                const checkpoint = await arrayBufferOf(await vm.saveProjectSb3('arraybuffer'));
                requireRevision(expected);
                clearHighlights();
                let began = false;
                try {
                    await vm.loadProject(request.data, () => {
                        requireRevision(expected);
                        began = true;
                    });
                    store.dispatch(setProjectTitle(request.title || ''));
                    if (vm.renderer) setTimer(() => vm.renderer.draw());
                    await new Promise(resolve => setTimer(resolve));
                    store.dispatch(setProjectUnchanged());
                    recoveryCheckpoint = null;
                    return {revision: revision, projectEpoch: projectEpoch, projectChanged: false};
                } catch (error) {
                    if (began) {
                        recoveryCheckpoint = {data: checkpoint, title: title};
                        try {
                            await vm.loadProject(checkpoint);
                            store.dispatch(setProjectTitle(title));
                            store.dispatch(changed ? setProjectChanged() : setProjectUnchanged());
                            notify(EVENT_TYPES.PROJECT_CHANGED, {revision: revision, projectChanged: changed});
                            recoveryCheckpoint = null;
                        } catch (restoreError) {
                            throw new BridgeError(ERROR_CODES.RECOVERY_FAILED,
                                'The project could not be restored. Download a file to recover your previous work.');
                        }
                    }
                    if (error instanceof BridgeError) throw error;
                    throw new BridgeError(ERROR_CODES.LOAD_FAILED,
                        began ? 'That file could not be opened. Your previous project was restored.' :
                            'That file could not be opened. Your current project was not changed.');
                }
            });
        },

        markSaved (request) {
            if (request.revision === revision) {
                store.dispatch(setProjectUnchanged());
                return {projectChanged: false, revision: revision};
            }
            return {projectChanged: projectChanged(), revision: revision};
        },

        setLanguage (request) {
            const locale = resolveLocale(request.locale, getState().locales.messagesByLocale);
            if (!locale) throw new BridgeError(ERROR_CODES.UNSUPPORTED, 'The editor does not have that language.');
            if (getState().locales.locale !== locale) {
                store.dispatch(selectLocale(locale));
                if (typeof document !== 'undefined') document.documentElement.lang = locale;
            }
            return {locale: locale};
        },

        startTrace (request) {
            requireIdle();
            if (typeof vm.startExecutionTrace !== 'function') {
                throw new BridgeError(ERROR_CODES.UNSUPPORTED, 'This editor cannot watch projects run.');
            }
            lastTrace = null;
            traceRevision = revision;
            vm.startExecutionTrace({
                maxDurationMs: request.maxDurationMs,
                maxEvents: LIMITS.MAX_TRACE_EVENTS,
                maxBlocks: LIMITS.MAX_TRACE_BLOCKS
            });
            return {active: true, maxDurationMs: request.maxDurationMs, revision: revision};
        },

        stopTrace () {
            if (typeof vm.stopExecutionTrace !== 'function') {
                throw new BridgeError(ERROR_CODES.UNSUPPORTED, 'This editor cannot watch projects run.');
            }
            const stopped = vm.stopExecutionTrace();
            const summary = traceRevision === revision && stopped ?
                Object.assign({}, stopped, {revision: traceRevision}) : null;
            if (summary) lastTrace = summary;
            return {trace: describeTrace(summary || lastTrace, vm.runtime), revision: revision};
        }
    };
};

export {
    createVmAdapter as default,
    resolveLocale
};
