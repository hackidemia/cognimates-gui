/**
 * Build a bounded, read-only snapshot of the child's project for the helper.
 *
 * Only the selected sprite's blocks are included (that is what the child is
 * looking at), at most LIMITS.MAX_CONTEXT_BLOCKS of them, walked script by
 * script so truncation drops whole tail scripts first. Variable values are
 * only included when explicitly requested and are truncated.
 *
 * This is static inspection of the program. It says nothing about what
 * happened when the project ran; that only comes from an execution trace.
 */
import {LIMITS} from './protocol';

const truncate = (value, max) => {
    const s = value === null || typeof value === 'undefined' ? '' : String(value);
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

const blockMapOf = target => (target && target.blocks && target.blocks._blocks) || {};

const describeTarget = target => ({
    id: target.id,
    name: truncate(target.getName(), LIMITS.MAX_NAME_LENGTH),
    isStage: !!target.isStage,
    costumeCount: target.getCostumes ? target.getCostumes().length : 0,
    soundCount: target.getSounds ? target.getSounds().length : 0,
    scriptCount: target.blocks && target.blocks.getScripts ? target.blocks.getScripts().length : 0
});

const describeBlock = (block, blocks, targetId) => {
    const inputs = {};
    Object.keys(block.inputs || {}).forEach(name => {
        const input = block.inputs[name];
        if (!input) return;
        const child = input.block ? blocks[input.block] : null;
        if (child && child.shadow && child.id === input.shadow) {
            // A typed-in value (number/text/menu) - report the literal.
            const fieldNames = Object.keys(child.fields || {});
            const value = fieldNames.length ? child.fields[fieldNames[0]].value : '';
            inputs[name] = {literal: truncate(value, LIMITS.MAX_VALUE_LENGTH)};
        } else if (child) {
            inputs[name] = {blockId: child.id};
        }
    });
    const fields = {};
    Object.keys(block.fields || {}).forEach(name => {
        fields[name] = truncate(block.fields[name].value, LIMITS.MAX_VALUE_LENGTH);
    });
    return {
        id: block.id,
        opcode: truncate(block.opcode, 64),
        targetId: targetId,
        topLevel: !!block.topLevel,
        parent: block.parent || null,
        next: block.next || null,
        inputs: inputs,
        fields: fields
    };
};

/**
 * Walk the non-shadow blocks of a target script by script.
 * @param {object} target VM target
 * @param {number} limit maximum number of blocks
 * @return {{blocks: Array, scripts: Array, truncated: boolean}} walk result
 */
const walkTargetBlocks = (target, limit) => {
    const blocks = blockMapOf(target);
    const scripts = target.blocks.getScripts();
    const out = [];
    const scriptInfo = [];
    const seen = {};
    let truncated = false;
    const visit = id => {
        const stack = [id];
        let count = 0;
        while (stack.length) {
            const current = stack.pop();
            const block = blocks[current];
            if (!block || seen[current]) continue;
            seen[current] = true;
            if (block.shadow) continue;
            if (out.length >= limit) {
                truncated = true;
                return count;
            }
            out.push(describeBlock(block, blocks, target.id));
            count++;
            if (block.next) stack.push(block.next);
            Object.keys(block.inputs || {}).reverse()
                .forEach(name => {
                    const input = block.inputs[name];
                    if (input && input.block) stack.push(input.block);
                });
        }
        return count;
    };
    for (let i = 0; i < scripts.length; i++) {
        const top = blocks[scripts[i]];
        if (!top) continue;
        if (scriptInfo.length < LIMITS.MAX_CONTEXT_SCRIPTS) {
            scriptInfo.push({topBlockId: top.id, hatOpcode: top.opcode, blockCount: visit(top.id)});
        } else {
            truncated = true;
        }
        if (truncated) break;
    }
    return {blocks: out, scripts: scriptInfo, truncated: truncated};
};

const describeVariables = (stage, target) => {
    const out = [];
    let truncated = false;
    const add = (owner, scope) => {
        if (!owner || !owner.variables) return;
        Object.keys(owner.variables).forEach(id => {
            const v = owner.variables[id];
            if (!v || v.isCloud) return;
            if (out.length >= LIMITS.MAX_CONTEXT_VARIABLES) {
                truncated = true;
                return;
            }
            const value = Array.isArray(v.value) ? `[list of ${v.value.length}]` : v.value;
            out.push({
                id: id,
                name: truncate(v.name, LIMITS.MAX_NAME_LENGTH),
                type: v.type || '',
                scope: scope,
                value: truncate(value, LIMITS.MAX_VALUE_LENGTH)
            });
        });
    };
    if (target && !target.isStage) add(target, 'sprite');
    add(stage, 'stage');
    return {variables: out, truncated: truncated};
};

/**
 * Map a VM execution trace summary onto ids that exist in this project.
 * @param {object} summary vm.getExecutionTraceSummary()
 * @param {object} runtime VM runtime
 * @return {?object} bounded trace for the helper, or null
 */
const describeTrace = (summary, runtime) => {
    if (!summary) return null;
    const exists = (targetId, blockId) => {
        const target = runtime.getTargetById(targetId);
        return !!(target && target.blocks.getBlock(blockId));
    };
    return {
        source: 'vm-execution-trace',
        revision: summary.revision,
        limits: summary.limits,
        active: !!summary.active,
        stoppedReason: summary.stoppedReason || null,
        durationMs: summary.durationMs,
        events: (summary.events || []).slice(0, LIMITS.MAX_TRACE_EVENTS)
            .filter(e => e.targetId && e.topBlockId && exists(e.targetId, e.topBlockId))
            .map(e => ({
                type: e.type,
                t: e.t,
                targetId: e.targetId,
                targetName: truncate(e.targetName, LIMITS.MAX_NAME_LENGTH),
                topBlockId: e.topBlockId,
                topOpcode: e.topOpcode
            })),
        executedBlocks: (summary.executedBlocks || []).slice(0, LIMITS.MAX_TRACE_BLOCKS)
            .filter(b => exists(b.targetId, b.blockId))
            .map(b => ({
                targetId: b.targetId,
                blockId: b.blockId,
                opcode: b.opcode,
                topBlockId: b.topBlockId,
                count: b.count
            })),
        droppedEvents: summary.droppedEvents || 0,
        droppedBlocks: summary.droppedBlocks || 0
    };
};

/**
 * @param {object} options snapshot options
 * @param {object} options.vm the VM
 * @param {number} options.revision current project revision
 * @param {boolean} options.projectChanged unsaved-changes flag from the GUI
 * @param {string} [options.title] project title
 * @param {boolean} [options.includeVariables] include (truncated) variable values
 * @param {boolean} [options.includeTrace] include the execution trace if one exists
 * @param {object} [options.traceSummary] running or last finished VM trace summary
 * @return {object} context snapshot
 */
const buildProjectContext = options => {
    const vm = options.vm;
    const runtime = vm.runtime;
    const stage = runtime.getTargetForStage();
    const editing = vm.editingTarget || stage;
    const originals = runtime.targets.filter(t => t.isOriginal);
    const walk = editing ? walkTargetBlocks(editing, LIMITS.MAX_CONTEXT_BLOCKS) :
        {blocks: [], scripts: [], truncated: false};
    const context = {
        revision: options.revision,
        projectChanged: !!options.projectChanged,
        title: truncate(options.title || '', LIMITS.MAX_TITLE_LENGTH),
        analysis: 'static',
        editingTarget: editing ? {id: editing.id,
            name: truncate(editing.getName(), LIMITS.MAX_NAME_LENGTH),
            isStage: !!editing.isStage} : null,
        targets: originals.slice(0, LIMITS.MAX_CONTEXT_TARGETS).map(describeTarget),
        scripts: walk.scripts,
        blocks: walk.blocks,
        truncated: {
            targets: originals.length > LIMITS.MAX_CONTEXT_TARGETS,
            blocks: walk.truncated,
            variables: false
        }
    };
    if (options.includeVariables) {
        const vars = describeVariables(stage, editing);
        context.variables = vars.variables;
        context.truncated.variables = vars.truncated;
    }
    if (options.includeTrace) {
        context.trace = describeTrace(options.traceSummary || null, runtime);
    }
    return context;
};

/**
 * Find which original target owns each block id.
 * @param {object} runtime VM runtime
 * @param {Array.<string>} blockIds ids to locate
 * @return {object.<string, string>} blockId -> targetId (missing ids omitted)
 */
const locateBlocks = (runtime, blockIds) => {
    const found = {};
    runtime.targets.filter(t => t.isOriginal).forEach(target => {
        blockIds.forEach(id => {
            if (!found[id]) {
                const block = target.blocks.getBlock(id);
                if (block && !block.shadow) found[id] = target.id;
            }
        });
    });
    return found;
};

export {
    buildProjectContext,
    describeTrace,
    locateBlocks
};
