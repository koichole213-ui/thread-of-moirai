export const PROMPT_POST_PROCESSING = Object.freeze({
    NONE: '',
    MERGE: 'merge',
    MERGE_TOOLS: 'merge_tools',
    SEMI: 'semi',
    SEMI_TOOLS: 'semi_tools',
    STRICT: 'strict',
    STRICT_TOOLS: 'strict_tools',
    SINGLE: 'single',
});

export const WORLD_INFO_POSITION = Object.freeze({
    BEFORE_CHARACTER: 0,
    AFTER_CHARACTER: 1,
    AUTHOR_NOTE_TOP: 2,
    AUTHOR_NOTE_BOTTOM: 3,
    AT_DEPTH: 4,
    EXAMPLES_TOP: 5,
    EXAMPLES_BOTTOM: 6,
    OUTLET: 7,
});

const VALID_ROLES = new Set(['system', 'user', 'assistant']);

export function normalizePromptRole(value, fallback = 'system') {
    const role = String(value || '').trim().toLowerCase();
    if (VALID_ROLES.has(role)) return role;
    const numeric = Number(value);
    if (numeric === 1) return 'user';
    if (numeric === 2) return 'assistant';
    return fallback;
}

export function normalizeRequestMessages(messages = []) {
    return (Array.isArray(messages) ? messages : [])
        .filter(message => message && typeof message === 'object')
        .filter(message => !['tool', 'function'].includes(String(message.role || '').toLowerCase()))
        .map((message, index) => {
            const content = typeof message.content === 'string'
                ? message.content
                : (Array.isArray(message.content)
                    ? message.content.map(part => typeof part === 'string' ? part : (part?.text || '')).join('')
                    : String(message.content ?? ''));
            return {
                role: normalizePromptRole(message.role),
                content,
                ...(message.name ? { name: String(message.name) } : {}),
                source: String(message.source || 'request'),
                sourceId: String(message.sourceId || `message-${index + 1}`),
            };
        })
        .filter(message => message.content.trim());
}

function mergeAdjacentMessages(messages) {
    const merged = [];
    for (const message of messages) {
        const previous = merged[merged.length - 1];
        if (previous?.role === message.role && previous?.name === message.name) {
            previous.content = [previous.content, message.content].filter(Boolean).join('\n\n');
            previous.source = previous.source === message.source ? previous.source : 'merged';
            previous.sourceId = [previous.sourceId, message.sourceId].filter(Boolean).join('+');
        } else {
            merged.push({ ...message });
        }
    }
    return merged;
}

export function squashAdjacentSystemMessages(messages = []) {
    const normalized = normalizeRequestMessages(messages);
    const squashed = [];
    for (const message of normalized) {
        const previous = squashed[squashed.length - 1];
        const isDialogueExample = message.sourceId === 'dialogueExamples'
            || previous?.sourceId === 'dialogueExamples';
        if (message.role === 'system' && previous?.role === 'system' && !isDialogueExample) {
            previous.content = [previous.content, message.content].filter(Boolean).join('\n\n');
            previous.source = previous.source === message.source ? previous.source : 'squashed-system';
            previous.sourceId = [previous.sourceId, message.sourceId].filter(Boolean).join('+');
        } else {
            squashed.push({ ...message });
        }
    }
    return squashed;
}

export function noToolsPostProcessingMode(value = '') {
    const mode = String(value || '').toLowerCase();
    if (mode === PROMPT_POST_PROCESSING.MERGE_TOOLS) return PROMPT_POST_PROCESSING.MERGE;
    if (mode === PROMPT_POST_PROCESSING.SEMI_TOOLS) return PROMPT_POST_PROCESSING.SEMI;
    if (mode === PROMPT_POST_PROCESSING.STRICT_TOOLS) return PROMPT_POST_PROCESSING.STRICT;
    return Object.values(PROMPT_POST_PROCESSING).includes(mode) ? mode : PROMPT_POST_PROCESSING.NONE;
}

export function applyPromptPostProcessing(messages = [], mode = '', placeholder = '[Start a new chat]') {
    const normalized = normalizeRequestMessages(messages);
    const safeMode = noToolsPostProcessingMode(mode);
    if (safeMode === PROMPT_POST_PROCESSING.NONE) return normalized;
    if (safeMode === PROMPT_POST_PROCESSING.SINGLE) {
        const content = normalized.map(message => `${message.role.toUpperCase()}:\n${message.content}`).join('\n\n');
        return content ? [{ role: 'user', content, source: 'post-processing', sourceId: 'single' }] : [];
    }

    const merged = mergeAdjacentMessages(normalized);
    if (safeMode !== PROMPT_POST_PROCESSING.STRICT) return merged;

    const result = [];
    for (const message of merged) {
        const previous = result[result.length - 1];
        if (message.role === 'system') {
            result.push(message);
            continue;
        }
        if (!previous || previous.role === 'system') {
            if (message.role === 'assistant') {
                result.push({ role: 'user', content: placeholder, source: 'post-processing', sourceId: 'strict-placeholder' });
            }
        } else if (previous.role === message.role) {
            result.push({
                role: message.role === 'user' ? 'assistant' : 'user',
                content: placeholder,
                source: 'post-processing',
                sourceId: 'strict-placeholder',
            });
        }
        result.push(message);
    }
    return result;
}

function numeric(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

export function normalizeWorldInfoEntry(entry = {}, index = 0) {
    const raw = entry.raw || entry;
    return {
        ...entry,
        content: String(entry.content ?? raw.content ?? '').trim(),
        position: numeric(entry.position ?? raw.position, WORLD_INFO_POSITION.BEFORE_CHARACTER),
        depth: Math.max(0, Math.floor(numeric(entry.depth ?? raw.depth, 4))),
        order: numeric(entry.order ?? raw.order, 100),
        role: normalizePromptRole(entry.role ?? raw.role),
        outletName: String(entry.outletName ?? raw.outletName ?? raw.outlet ?? '').trim(),
        sourceId: String(entry.sourceId ?? entry.uid ?? raw.uid ?? `world-info-${index + 1}`),
        _index: index,
    };
}

export function classifyWorldInfoEntries(entries = []) {
    const result = {
        before: [], after: [], authorNoteTop: [], authorNoteBottom: [],
        examplesTop: [], examplesBottom: [], atDepth: [], outlets: new Map(),
    };
    const normalized = (Array.isArray(entries) ? entries : [])
        .map(normalizeWorldInfoEntry)
        .filter(entry => entry.content)
        .sort((a, b) => a.order - b.order || a._index - b._index);
    for (const entry of normalized) {
        if (entry.position === WORLD_INFO_POSITION.AFTER_CHARACTER) result.after.push(entry);
        else if (entry.position === WORLD_INFO_POSITION.AUTHOR_NOTE_TOP) result.authorNoteTop.push(entry);
        else if (entry.position === WORLD_INFO_POSITION.AUTHOR_NOTE_BOTTOM) result.authorNoteBottom.push(entry);
        else if (entry.position === WORLD_INFO_POSITION.AT_DEPTH) result.atDepth.push(entry);
        else if (entry.position === WORLD_INFO_POSITION.EXAMPLES_TOP) result.examplesTop.push(entry);
        else if (entry.position === WORLD_INFO_POSITION.EXAMPLES_BOTTOM) result.examplesBottom.push(entry);
        else if (entry.position === WORLD_INFO_POSITION.OUTLET) {
            if (!entry.outletName) continue;
            if (!result.outlets.has(entry.outletName)) result.outlets.set(entry.outletName, []);
            result.outlets.get(entry.outletName).push(entry);
        } else result.before.push(entry);
    }
    return result;
}

function entriesText(entries) {
    return entries.map(entry => entry.content).filter(Boolean).join('\n\n');
}

export function expandWorldInfoOutlets(content = '', outlets = new Map()) {
    return String(content || '').replace(/\{\{outlet::([^}]+)\}\}/gi, (_match, name) => {
        const wanted = String(name || '').trim().toLowerCase();
        const found = [...outlets.entries()].find(([key]) => String(key).trim().toLowerCase() === wanted);
        return found ? entriesText(found[1]) : '';
    });
}

export function insertMessagesAtDepth(chatMessages = [], entries = []) {
    const result = normalizeRequestMessages(chatMessages);
    const ordered = (Array.isArray(entries) ? entries : [])
        .map((entry, index) => ({
            content: String(entry?.content || '').trim(),
            depth: Math.max(0, Math.floor(numeric(entry?.depth, 4))),
            order: numeric(entry?.order, 100),
            role: normalizePromptRole(entry?.role),
            source: String(entry?.source || 'depth-injection'),
            sourceId: String(entry?.sourceId || `depth-${index + 1}`),
            _index: index,
        }))
        .filter(entry => entry.content)
        .sort((a, b) => b.depth - a.depth
            || a.order - b.order
            || ['system', 'user', 'assistant'].indexOf(a.role) - ['system', 'user', 'assistant'].indexOf(b.role)
            || a._index - b._index);
    for (const entry of ordered) {
        const index = Math.max(0, result.length - Math.min(entry.depth, result.length));
        result.splice(index, 0, {
            role: entry.role,
            content: entry.content,
            source: entry.source,
            sourceId: entry.sourceId,
        });
    }
    return result;
}

export function insertWorldInfoAtDepth(chatMessages = [], entries = []) {
    return insertMessagesAtDepth(chatMessages, (Array.isArray(entries) ? entries : []).map((entry, index) => {
        const normalized = normalizeWorldInfoEntry(entry, index);
        return { ...normalized, source: 'world-info-depth' };
    }));
}

const SLOT_IDENTIFIERS = Object.freeze({
    worldInfoBefore: 'worldInfoBefore',
    charDescription: 'charDescription',
    charPersonality: 'charPersonality',
    scenario: 'scenario',
    personaDescription: 'personaDescription',
    worldInfoAfter: 'worldInfoAfter',
    dialogueExamples: 'dialogueExamples',
    chatHistory: 'chatHistory',
});

function addMessage(target, role, content, source, sourceId) {
    if (!String(content || '').trim()) return;
    target.push({ role: normalizePromptRole(role), content: String(content), source, sourceId });
}

export function composePresetMessages({
    presetEntries = [],
    slots = {},
    worldInfoEntries = [],
    chatMessages = [],
    tailMessages = [],
    postProcessing = '',
    squashSystemMessages = false,
} = {}) {
    const world = classifyWorldInfoEntries(worldInfoEntries);
    const messages = [];
    const entries = Array.isArray(presetEntries) ? presetEntries : [];
    const relativeEntries = entries.filter(entry => Number(entry?.injectionPosition) !== 1);
    const absoluteEntries = entries.filter(entry => Number(entry?.injectionPosition) === 1);
    const hasSlot = new Set(entries.map(entry => SLOT_IDENTIFIERS[entry.id]).filter(Boolean));
    const slotText = {
        worldInfoBefore: entriesText(world.before),
        charDescription: String(slots.charDescription || ''),
        charPersonality: String(slots.charPersonality || ''),
        scenario: String(slots.scenario || ''),
        personaDescription: String(slots.personaDescription || ''),
        worldInfoAfter: entriesText(world.after),
        dialogueExamples: [entriesText(world.examplesTop), slots.dialogueExamples, entriesText(world.examplesBottom)].filter(Boolean).join('\n\n'),
    };
    const depthEntries = [
        ...world.atDepth.map(entry => ({ ...entry, source: 'world-info-depth' })),
        ...absoluteEntries.map((entry, index) => ({
            content: expandWorldInfoOutlets(entry.content || '', world.outlets),
            depth: entry.injectionDepth ?? 4,
            order: entry.injectionOrder ?? 100,
            role: entry.role,
            source: 'preset-depth',
            sourceId: String(entry.id || `preset-depth-${index + 1}`),
        })),
    ];
    const history = insertMessagesAtDepth(chatMessages, depthEntries);
    const authorNoteTop = entriesText(world.authorNoteTop);
    const authorNoteBottom = entriesText(world.authorNoteBottom);

    for (const entry of relativeEntries) {
        const id = String(entry.id || '');
        const role = normalizePromptRole(entry.role);
        if (id === 'chatHistory') {
            addMessage(messages, 'system', authorNoteTop, 'world-info-author-note', 'author-note-top');
            messages.push(...history);
            addMessage(messages, 'system', authorNoteBottom, 'world-info-author-note', 'author-note-bottom');
            continue;
        }
        const dynamic = SLOT_IDENTIFIERS[id] ? slotText[SLOT_IDENTIFIERS[id]] : '';
        const content = expandWorldInfoOutlets(dynamic || entry.content || '', world.outlets);
        addMessage(messages, role, content, SLOT_IDENTIFIERS[id] ? 'preset-slot' : 'preset', id || entry.sourceId);
    }

    const fallbackSlots = [
        ['worldInfoBefore', 'system'], ['charDescription', 'system'], ['charPersonality', 'system'],
        ['scenario', 'system'], ['personaDescription', 'system'], ['worldInfoAfter', 'system'],
        ['dialogueExamples', 'system'],
    ];
    for (const [slot, role] of fallbackSlots) {
        if (!hasSlot.has(slot)) addMessage(messages, role, slotText[slot], 'fallback-slot', slot);
    }
    if (!hasSlot.has('chatHistory')) {
        addMessage(messages, 'system', authorNoteTop, 'world-info-author-note', 'author-note-top');
        messages.push(...history);
        addMessage(messages, 'system', authorNoteBottom, 'world-info-author-note', 'author-note-bottom');
    }
    messages.push(...normalizeRequestMessages(tailMessages));
    const presetProcessed = squashSystemMessages ? squashAdjacentSystemMessages(messages) : messages;
    return applyPromptPostProcessing(presetProcessed, postProcessing);
}

export function composeGenerationContinuationMessages({
    presetEntries = [],
    slots = {},
    worldInfoEntries = [],
    chatMessages = [],
    foundationTailMessages = [],
    continuationSystemPrompt = '',
    continuationUserPrompt = '',
    squashSystemMessages = false,
} = {}) {
    const tailMessages = [
        ...normalizeRequestMessages(foundationTailMessages),
        String(continuationUserPrompt || '').trim() ? {
            role: 'user',
            content: String(continuationUserPrompt).trim(),
            source: 'theater-continuation',
            sourceId: 'continuation-round',
        } : null,
        String(continuationSystemPrompt || '').trim() ? {
            role: 'system',
            content: String(continuationSystemPrompt).trim(),
            source: 'theater-rules',
            sourceId: 'continuation-rules',
        } : null,
    ].filter(Boolean);
    return composePresetMessages({
        presetEntries,
        slots,
        worldInfoEntries,
        chatMessages,
        tailMessages,
        squashSystemMessages,
    });
}
