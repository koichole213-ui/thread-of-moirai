const REASONING_TAG_NAMES = new Set(['think', 'thinking', 'electric']);
const COMPLETE_TAG_PATTERN = /<\s*(\/?)\s*(think|thinking|electric)\b[^>]*>/gi;
const TAG_PREFIXES = Object.freeze([
    '<think>',
    '</think>',
    '<thinking>',
    '</thinking>',
    '<electric>',
    '</electric>',
]);

function trailingPartialTagLength(value) {
    const text = String(value || '');
    const start = text.lastIndexOf('<');
    if (start < 0) return 0;
    const suffix = text.slice(start).toLocaleLowerCase();
    if (suffix.includes('>')) return 0;
    return TAG_PREFIXES.some(tag => tag.startsWith(suffix)) ? text.length - start : 0;
}

/**
 * Removes model reasoning wrapped in <thinking>, <think>, or <electric>
 * without exposing an unfinished block during cumulative streaming updates.
 */
export function filterTaggedReasoning(value) {
    const text = String(value || '');
    if (!text) return { content: '', hadReasoning: false, incomplete: false };

    let content = '';
    let cursor = 0;
    let depth = 0;
    let hadReasoning = false;
    COMPLETE_TAG_PATTERN.lastIndex = 0;

    let match;
    while ((match = COMPLETE_TAG_PATTERN.exec(text)) !== null) {
        const segment = text.slice(cursor, match.index);
        if (depth === 0) content += segment;

        const closing = match[1] === '/';
        const name = String(match[2] || '').toLocaleLowerCase();
        if (REASONING_TAG_NAMES.has(name)) {
            hadReasoning = true;
            if (closing) depth = Math.max(0, depth - 1);
            else depth++;
        }
        cursor = COMPLETE_TAG_PATTERN.lastIndex;
    }

    if (depth === 0) {
        let tail = text.slice(cursor);
        const partialLength = trailingPartialTagLength(tail);
        if (partialLength) {
            hadReasoning = true;
            tail = tail.slice(0, -partialLength);
        }
        content += tail;
    }

    return {
        content,
        hadReasoning,
        incomplete: depth > 0,
    };
}

export function reasoningSafeContent(value) {
    return filterTaggedReasoning(value).content;
}
