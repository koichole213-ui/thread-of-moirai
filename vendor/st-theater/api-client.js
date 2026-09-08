export const API_PROTOCOLS = Object.freeze({ AUTO: 'auto', OPENAI: 'openai', ANTHROPIC: 'anthropic' });
export const DEFAULT_MAX_OUTPUT_TOKENS = 16384;

import { applyPromptPostProcessing } from './request-layout.js';

export function resolveMainApiModel(ctx, oai = ctx?.oai_settings) {
    let fromContext = '';
    if (typeof ctx?.getChatCompletionModel === 'function') {
        try {
            fromContext = ctx.getChatCompletionModel();
        } catch {
            // 不同 SillyTavern 版本暴露的上下文对象并不完全一致，继续检查设置字段。
        }
    }
    const candidates = [
        fromContext,
        oai?.openai_model,
        oai?.model,
        oai?.custom_model,
        oai?.claude_model,
        oai?.google_model,
        oai?.openrouter_model,
        oai?.mistralai_model,
        oai?.cohere_model,
        oai?.perplexity_model,
        oai?.groq_model,
    ];
    return String(candidates.find(value => String(value || '').trim()) || '').trim();
}

export function normalizeMaxTokens(value, fallback = DEFAULT_MAX_OUTPUT_TOKENS) {
    const parsed = Math.floor(Number(value));
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(131072, Math.max(256, parsed));
}

export function resolveProtocol(selected, url = '') {
    if (selected === API_PROTOCOLS.OPENAI || selected === API_PROTOCOLS.ANTHROPIC) return selected;
    return /anthropic|claude/i.test(url) ? API_PROTOCOLS.ANTHROPIC : API_PROTOCOLS.OPENAI;
}

export function buildApiEndpoint(url, protocol) {
    const base = String(url || '').replace(/\/+$/, '');
    const path = protocol === API_PROTOCOLS.ANTHROPIC ? '/messages' : '/chat/completions';
    if (base.endsWith(path)) return base;
    if (base.endsWith('/v1')) return base + path;
    return base + '/v1' + path;
}

export const MESSAGE_COMPATIBILITY = Object.freeze({
    NATIVE: 'native',
    OPENAI_SYSTEM_FIRST: 'openai-system-first',
    ANTHROPIC_TOP_LEVEL_SYSTEM: 'anthropic-top-level-system',
});

function mergeAdjacentCompatibilityMessages(messages = [], source = 'independent-api-compat') {
    const merged = [];
    for (const message of messages) {
        const previous = merged[merged.length - 1];
        if (previous?.role === message.role) {
            previous.content = [previous.content, message.content].filter(Boolean).join('\n\n');
            previous.source = source;
            previous.sourceId = `${message.role}-fold`;
            previous.foldedMessageCount = (previous.foldedMessageCount || 1) + (message.foldedMessageCount || 1);
        } else {
            merged.push({ ...message });
        }
    }
    return merged;
}

// OpenAI 兼容网关对中后段 system 的支持并不一致。只要 system 出现在
// 对话消息之后，就把全部 system 按原顺序合为开头一条，并保留每一轮
// user/assistant 的先后和完整内容。原本已经是纯开头 system 的请求不改。
export function applyIndependentOpenAICompatibility(messages = []) {
    const source = Array.isArray(messages) ? messages.map(message => ({ ...message })) : [];
    let dialogueStarted = false;
    let hasDeferredSystem = false;
    for (const message of source) {
        if (message.role === 'system') {
            if (dialogueStarted) hasDeferredSystem = true;
        } else {
            dialogueStarted = true;
        }
    }
    const hasRiskyTopology = hasDeferredSystem;
    if (!hasRiskyTopology) {
        return { messages: source, mode: MESSAGE_COMPATIBILITY.NATIVE };
    }

    const systemMessages = source.filter(message => message.role === 'system');
    const dialogueMessages = source.filter(message => message.role !== 'system');
    const foldedSystem = {
        role: 'system',
        content: systemMessages.map(message => message.content).filter(Boolean).join('\n\n'),
        source: 'openai-compat',
        sourceId: 'system-fold',
        foldedMessageCount: systemMessages.length,
    };
    return {
        messages: [foldedSystem, ...mergeAdjacentCompatibilityMessages(dialogueMessages, 'openai-compat')],
        mode: MESSAGE_COMPATIBILITY.OPENAI_SYSTEM_FIRST,
    };
}

export function buildApiRequest({
    url, protocol, key, model, systemPrompt, userPrompt, messages,
    postProcessing = '', maxTokens = DEFAULT_MAX_OUTPUT_TOKENS, stream = true,
}) {
    const resolved = resolveProtocol(protocol, url);
    const endpoint = buildApiEndpoint(url, resolved);
    const finalMessages = applyPromptPostProcessing(
        Array.isArray(messages) ? messages : [
            { role: 'system', content: systemPrompt, source: 'request', sourceId: 'system' },
            { role: 'user', content: userPrompt, source: 'request', sourceId: 'user' },
        ],
        postProcessing,
    );
    if (resolved === API_PROTOCOLS.ANTHROPIC) {
        const systemMessages = finalMessages.filter(message => message.role === 'system');
        const system = systemMessages.map(message => message.content).filter(Boolean).join('\n\n');
        const anthropicMessages = finalMessages
            .filter(message => message.role !== 'system')
            .map(message => ({ role: message.role, content: message.content }));
        return {
            protocol: resolved, endpoint,
            headers: { 'Content-Type': 'application/json', Accept: stream ? 'text/event-stream' : 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
            body: { model, max_tokens: maxTokens, stream, system, messages: anthropicMessages },
            messages: finalMessages,
            messageCompatibility: systemMessages.length
                ? MESSAGE_COMPATIBILITY.ANTHROPIC_TOP_LEVEL_SYSTEM
                : MESSAGE_COMPATIBILITY.NATIVE,
        };
    }
    const compatible = applyIndependentOpenAICompatibility(finalMessages);
    const headers = { 'Content-Type': 'application/json', Accept: stream ? 'text/event-stream' : 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;
    return {
        protocol: resolved, endpoint, headers,
        body: { model, messages: compatible.messages.map(message => ({ role: message.role, content: message.content })), stream, max_tokens: maxTokens },
        messages: compatible.messages,
        messageCompatibility: compatible.mode,
    };
}

export function maxTokenFallbackSequence(value) {
    const requested = normalizeMaxTokens(value);
    const standardLimits = [16384, 8192, 4096, 2048, 1024, 512, 256];
    return [requested, ...standardLimits.filter(limit => limit < requested)]
        .filter((limit, index, all) => all.indexOf(limit) === index);
}

export function isMaxTokenLimitError(status, body = '') {
    if (![400, 413, 422].includes(Number(status))) return false;
    const text = String(body || '');
    return /max[_\s-]?tokens|max(?:imum)?\s+output\s+tokens|maximum\s+context\s+length|context[_\s-]?length|requested\s+tokens|上下文(?:窗口|长度)?|对话历史|系统提示/i.test(text)
        && /too\s+(?:large|high|many)|exceed|limit|maximum|at\s+most|less\s+than|must\s+be|<=|not\s+support|已满|超出|过长|减少|限制|上限/i.test(text);
}

export function retryAfterMilliseconds(value, now = Date.now()) {
    const text = String(value ?? '').trim();
    if (!text) return null;
    const seconds = Number(text);
    if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds * 1000));
    const timestamp = Date.parse(text);
    if (!Number.isFinite(timestamp)) return null;
    return Math.max(0, timestamp - Number(now || 0));
}

export function isRateLimitErrorMessage(value) {
    return /(?:\b429\b|too many requests|rate[\s_-]*limit|resource exhausted|quota (?:exceeded|exhausted)|请求过于频繁|限流)/i
        .test(String(value || ''));
}

const CONTENT_BLOCK_REASONS = Object.freeze({
    content_filter: 'content_filter',
    content_policy: 'content_policy',
    safety: 'safety',
    prohibited_content: 'prohibited_content',
    blocklist: 'blocklist',
    spii: 'spii',
    recitation: 'recitation',
    model_armor: 'model_armor',
    image_safety: 'image_safety',
    image_prohibited_content: 'image_prohibited_content',
    jailbreak: 'jailbreak',
    refusal: 'refusal',
});

export function contentBlockReason(value) {
    const normalized = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_');
    return CONTENT_BLOCK_REASONS[normalized] || null;
}

export function isContentBlockedStopReason(value) {
    return !!contentBlockReason(value);
}

export function isContentBlockedErrorMessage(value) {
    const text = String(value || '');
    return isContentBlockedStopReason(text)
        || /content[\s_-]*(?:filter|policy)|\bsafety(?:\s+filter)?\b|prohibited[\s_-]*content|blocklist|\bspii\b|recitation|model[\s_-]*armor|jailbreak/i.test(text);
}

export function normalizeStopReason(raw) {
    const value = String(raw || '').toLowerCase();
    if (value === 'length' || value === 'max_tokens' || value === 'max_tokens_reached') return 'length';
    if (value === 'stop' || value === 'end_turn' || value === 'stop_sequence') return 'stop';
    if (isContentBlockedStopReason(value)) return 'blocked';
    return raw ? 'unknown' : 'unknown';
}

export function isHtmlErrorResponse(contentType = '', text = '') {
    const type = String(contentType || '').toLowerCase();
    if (type.includes('text/html') || type.includes('application/xhtml+xml')) return true;
    return /^\s*(?:<!doctype\s+html\b|<html(?:\s|>))/i.test(String(text || ''));
}

export function extractResponseMeta(json, protocol = API_PROTOCOLS.OPENAI) {
    const candidateReason = protocol === API_PROTOCOLS.ANTHROPIC
        ? (json?.stop_reason || json?.delta?.stop_reason)
        : (json?.choices?.[0]?.finish_reason || json?.candidates?.[0]?.finishReason || json?.candidates?.[0]?.finish_reason);
    const promptBlockReason = json?.promptFeedback?.blockReason || json?.prompt_feedback?.block_reason || null;
    const rawStopReason = candidateReason || promptBlockReason || null;
    return {
        stopReason: normalizeStopReason(rawStopReason),
        rawStopReason,
        blockReason: contentBlockReason(candidateReason) || contentBlockReason(promptBlockReason),
        usage: json?.usage || json?.usageMetadata || null,
    };
}

export function textFromContentPart(part) {
    if (!part) return '';
    if (typeof part === 'string') return part;
    if (Array.isArray(part)) return part.map(textFromContentPart).join('');
    if (typeof part !== 'object') return '';
    return textFromContentPart(part.text)
        || textFromContentPart(part.content)
        || textFromContentPart(part.value)
        || textFromContentPart(part.output_text)
        || '';
}

export function extractStreamText(json, protocol = API_PROTOCOLS.OPENAI) {
    if (!json || typeof json !== 'object') return '';
    const isAnthropic = protocol === API_PROTOCOLS.ANTHROPIC;

    if (isAnthropic) {
        if (json.type === 'content_block_delta') return textFromContentPart(json.delta?.text || json.delta);
        if (json.type === 'message_delta') return textFromContentPart(json.delta?.text || json.delta?.content);
    }

    if (/\.output_text\.delta$/i.test(String(json.type || ''))) {
        return textFromContentPart(json.delta);
    }

    const choices = Array.isArray(json.choices) ? json.choices : [];
    for (const choice of choices) {
        const delta = choice?.delta || {};
        const message = choice?.message || {};
        const text = textFromContentPart(delta.content)
            || textFromContentPart(delta.text)
            || textFromContentPart(message.content)
            || textFromContentPart(choice?.text);
        if (text) return text;
    }

    const candidateText = textFromContentPart((Array.isArray(json.candidates) ? json.candidates : [])
        .map(candidate => Array.isArray(candidate?.content?.parts)
            ? candidate.content.parts.filter(part => part?.thought !== true)
            : candidate?.content));
    if (candidateText) return candidateText;

    const outputText = textFromContentPart((Array.isArray(json.output) ? json.output : [])
        .filter(item => !/reasoning|thought/i.test(String(item?.type || '')))
        .map(item => item?.content || item));
    if (outputText) return outputText;

    return textFromContentPart(json.delta?.content)
        || textFromContentPart(json.delta?.text)
        || textFromContentPart(json.message?.content)
        || textFromContentPart(json.content)
        || textFromContentPart(json.response)
        || textFromContentPart(json.output_text)
        || '';
}

export function hasReasoningContent(json) {
    if (!json || typeof json !== 'object') return false;
    const reasoningTokens = json?.usage?.completion_tokens_details?.reasoning_tokens
        ?? json?.usage?.output_tokens_details?.reasoning_tokens
        ?? json?.usageMetadata?.thoughtsTokenCount;
    if (Number(reasoningTokens) > 0) return true;

    if (/reasoning|thought/i.test(String(json.type || ''))
        && !!textFromContentPart(json.delta || json.summary || json.content || json.text)) return true;

    const choices = Array.isArray(json.choices) ? json.choices : [];
    if (choices.some(choice => [choice?.delta, choice?.message, choice]
        .some(part => textFromContentPart(part?.reasoning_content)
            || textFromContentPart(part?.reasoning)
            || textFromContentPart(part?.reasoning_details)))) return true;

    const candidates = Array.isArray(json.candidates) ? json.candidates : [];
    if (candidates.some(candidate => (candidate?.content?.parts || [])
        .some(part => part?.thought === true && !!textFromContentPart(part)))) return true;

    const output = Array.isArray(json.output) ? json.output : [];
    return output.some(item => /reasoning|thought/i.test(String(item?.type || ''))
        && !!textFromContentPart(item?.content || item?.summary || item));
}

export function extractApiErrorMessage(json) {
    if (!json || typeof json !== 'object') return '';
    const error = json.error;
    if (typeof error === 'string') return error.trim();
    if (error && typeof error === 'object') {
        return String(error.message || error.detail || error.error || error.status || '').trim();
    }
    if (json.type === 'error') {
        return String(json.message || json.detail || json.delta?.message || '').trim();
    }
    return '';
}
