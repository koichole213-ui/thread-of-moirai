import {
    API_PROTOCOLS,
    buildApiRequest,
    extractApiErrorMessage,
    extractResponseMeta,
    extractStreamText,
    hasReasoningContent,
    isContentBlockedErrorMessage,
    isContentBlockedStopReason,
    isHtmlErrorResponse,
    isMaxTokenLimitError,
    isRateLimitErrorMessage,
    maxTokenFallbackSequence,
    resolveMainApiModel,
    retryAfterMilliseconds,
} from './api-client.js';
import { REQUEST_DIAGNOSTIC_SIGNAL, createDiagnosticError } from './request-diagnostics.js';
import { filterTaggedReasoning } from './reasoning-filter.js';
import { applyPromptPostProcessing } from './request-layout.js';

export const RATE_LIMIT_DEFAULT_WAIT_MS = 3000;
export const RATE_LIMIT_MAX_AUTO_WAIT_MS = 15000;
export const CUSTOM_STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
export const MAIN_FIRST_TOKEN_TIMEOUT_MS = 180000;
export const MAIN_STREAM_IDLE_TIMEOUT_MS = 120000;
export const MAIN_RESPONSE_TIMEOUT_MS = 300000;

const noop = () => {};

function emitReasoningSafeChunk(onChunk, value) {
    onChunk(filterTaggedReasoning(value).content);
}

function reasoningOnlyError({ phase = 'body', transport = '' } = {}) {
    return createDiagnosticError(REQUEST_DIAGNOSTIC_SIGNAL.REASONING_ONLY, {
        code: 'THEATER_REASONING_ONLY', phase, transport,
    });
}

function reasoningSafeResult(result, { phase = 'body', transport = '' } = {}) {
    const rawText = typeof result === 'string'
        ? result
        : (result?.text || result?.content || '');
    const parsed = filterTaggedReasoning(rawText);
    if (!String(parsed.content || '').trim()) {
        if (parsed.hadReasoning) throw reasoningOnlyError({ phase, transport });
        throw noTextResponseError(result || {}, { phase, transport });
    }
    return typeof result === 'string'
        ? { text: parsed.content }
        : { ...result, text: parsed.content };
}

function noTextResponseError(meta = {}, { phase = 'body', transport = '' } = {}) {
    const rawStopReason = meta?.rawStopReason || meta?.blockReason || null;
    if (meta?.blockReason || isContentBlockedStopReason(rawStopReason)) {
        return createDiagnosticError(REQUEST_DIAGNOSTIC_SIGNAL.CONTENT_FILTER, {
            code: 'THEATER_CONTENT_FILTER', rawStopReason, phase, transport,
        });
    }
    if (meta?.stopReason === 'length') {
        return createDiagnosticError(REQUEST_DIAGNOSTIC_SIGNAL.TOKEN_LIMIT, {
            code: 'THEATER_OUTPUT_LIMIT', rawStopReason, phase, transport,
        });
    }
    return createDiagnosticError(REQUEST_DIAGNOSTIC_SIGNAL.EMPTY, {
        code: 'THEATER_RESPONSE_EMPTY', rawStopReason, phase, transport,
    });
}

function streamEmptyError({ phase = 'body', transport = 'stream' } = {}) {
    return createDiagnosticError(REQUEST_DIAGNOSTIC_SIGNAL.EMPTY, {
        code: 'THEATER_STREAM_EMPTY', phase, transport,
    });
}

function safeUsageSummary(usage = {}) {
    const number = (...values) => {
        const value = values.find(item => Number.isFinite(Number(item)));
        return value === undefined ? null : Number(value);
    };
    return {
        inputTokens: number(usage.prompt_tokens, usage.input_tokens, usage.promptTokenCount),
        outputTokens: number(usage.completion_tokens, usage.output_tokens, usage.candidatesTokenCount),
        reasoningTokens: number(
            usage?.completion_tokens_details?.reasoning_tokens,
            usage?.output_tokens_details?.reasoning_tokens,
            usage.thoughtsTokenCount,
        ),
        totalTokens: number(usage.total_tokens, usage.totalTokenCount),
    };
}

function responseFormat(json = {}) {
    if (Array.isArray(json.choices)) return 'choices';
    if (Array.isArray(json.candidates)) return 'candidates';
    if (Array.isArray(json.output) || /response\./i.test(String(json.type || ''))) return 'responses';
    if (/content_block|message_/i.test(String(json.type || '')) || json.stop_reason) return 'anthropic';
    return 'json';
}

function createResponseSummary({ response, transport, protocol, events = 0, json = null, meta = null, hasText = false, hasReasoning = false } = {}) {
    const usage = safeUsageSummary(meta?.usage || json?.usage || json?.usageMetadata || {});
    return {
        transport: String(transport || 'unknown'),
        protocol: String(protocol || 'unknown'),
        httpStatus: Number(response?.status) || null,
        contentType: String(response?.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase() || 'unknown',
        format: json ? responseFormat(json) : 'unknown',
        events: Math.max(0, Number(events) || 0),
        hasText: !!hasText,
        hasReasoning: !!hasReasoning,
        rawStopReason: meta?.rawStopReason || null,
        usage,
    };
}

function publicResult(result = {}) {
    if (!result || typeof result !== 'object' || !('responseSummary' in result)) return result;
    const { responseSummary: _responseSummary, ...publicFields } = result;
    return publicFields;
}

function attachResponseSummary(error, summary) {
    if (error && typeof error === 'object') error.apiResponseSummary = summary;
    return error;
}

function statusError(status, body = '', { phase = 'body', transport = '' } = {}) {
    const numericStatus = Number(status) || null;
    if (numericStatus === 429) {
        return createDiagnosticError(REQUEST_DIAGNOSTIC_SIGNAL.RATE_LIMIT, {
            code: 'THEATER_RATE_LIMIT', status: numericStatus, phase, transport,
        });
    }
    if (isMaxTokenLimitError(numericStatus, body)) {
        return createDiagnosticError(REQUEST_DIAGNOSTIC_SIGNAL.TOKEN_LIMIT, {
            code: 'THEATER_OUTPUT_LIMIT', status: numericStatus, phase, transport,
        });
    }
    if (isContentBlockedErrorMessage(body)) {
        return createDiagnosticError(REQUEST_DIAGNOSTIC_SIGNAL.CONTENT_FILTER, {
            code: 'THEATER_CONTENT_FILTER', status: numericStatus, phase, transport,
        });
    }
    const signal = numericStatus >= 400 && numericStatus <= 599
        ? `T-HTTP-${numericStatus}`
        : REQUEST_DIAGNOSTIC_SIGNAL.INVALID_RESPONSE;
    return createDiagnosticError(signal, {
        code: 'THEATER_HTTP_STATUS', status: numericStatus, phase, transport,
    });
}

function normalizeFetchError(error, { phase = 'body', transport = '' } = {}) {
    if (error?.name === 'AbortError' || error?.diagnosticSignal) return error;
    if (error instanceof TypeError
        || /failed to fetch|network(?:error| error)|load failed|connection reset|econnreset|socket hang up/i.test(String(error?.message || error || ''))) {
        return createDiagnosticError(REQUEST_DIAGNOSTIC_SIGNAL.NETWORK, {
            code: 'THEATER_NETWORK_FAILED', phase, transport,
        });
    }
    return error;
}

async function performCustomFetch(fetchRequest, { phase = 'body', transport = '' } = {}) {
    try {
        return await fetchRequest();
    } catch (error) {
        throw normalizeFetchError(error, { phase, transport });
    }
}

function shouldNotFallbackMainApi(error) {
    return [
        'THEATER_CONTENT_FILTER', 'THEATER_RATE_LIMIT', 'THEATER_OUTPUT_LIMIT', 'THEATER_CONFIG',
        'THEATER_REASONING_ONLY', 'THEATER_RESPONSE_EMPTY', 'THEATER_STREAM_EMPTY',
        'MAIN_FIRST_TOKEN_TIMEOUT', 'MAIN_STREAM_IDLE_TIMEOUT', 'MAIN_RESPONSE_TIMEOUT',
    ].includes(error?.code);
}

function normalizeMainApiFallbackError(error) {
    if (error?.name === 'AbortError' || error?.diagnosticSignal) return error;
    const message = String(error?.message || error || '');
    if (isContentBlockedErrorMessage(message)) {
        return createDiagnosticError(REQUEST_DIAGNOSTIC_SIGNAL.CONTENT_FILTER, {
            code: 'THEATER_CONTENT_FILTER', phase: 'main', transport: 'ChatCompletionService',
        });
    }
    if (isRateLimitErrorMessage(message)) {
        return createDiagnosticError(REQUEST_DIAGNOSTIC_SIGNAL.RATE_LIMIT, {
            code: 'THEATER_RATE_LIMIT', phase: 'main', transport: 'ChatCompletionService',
        });
    }
    if (/max[_\s-]?tokens|max(?:imum)?\s+(?:output|context)|输出上限|上下文上限|上下文(?:窗口|长度)?(?:已满|超出)|减少对话历史/i.test(message)) {
        return createDiagnosticError(REQUEST_DIAGNOSTIC_SIGNAL.TOKEN_LIMIT, {
            code: 'THEATER_OUTPUT_LIMIT', phase: 'main', transport: 'ChatCompletionService',
        });
    }
    return error;
}

export async function requestMainApi({
    ctx,
    systemPrompt,
    userPrompt,
    messages,
    postProcessing = '',
    presetName = '',
    onChunk = noop,
    onRequest = noop,
    shouldStream = true,
    signal,
    log = noop,
    onFallback = noop,
    onPath = noop,
    onResponse = noop,
    tavernHelper = globalThis.window?.TavernHelper,
    getContext = () => globalThis.SillyTavern?.getContext?.(),
    chatCompletionService,
} = {}) {
    const finalMessages = applyPromptPostProcessing(
        Array.isArray(messages) ? messages : [
            { role: 'system', content: systemPrompt, source: 'request', sourceId: 'system' },
            { role: 'user', content: userPrompt, source: 'request', sourceId: 'user' },
        ],
        postProcessing,
    );
    const oai = ctx?.oai_settings || globalThis.oai_settings;
    const configuredMaxTokens = Number(oai?.openai_max_tokens);
    // 0 在酒馆设置里表示交给当前预设/线路决定，不能把 max_tokens: 0 强行覆盖到请求中。
    const maxTokens = Number.isFinite(configuredMaxTokens) && configuredMaxTokens > 0
        ? Math.floor(configuredMaxTokens)
        : undefined;
    const model = resolveMainApiModel(ctx, oai) || '未识别';
    const CCS = chatCompletionService || ctx?.ChatCompletionService || getContext?.()?.ChatCompletionService;

    log('info', '请求发出', {
        mode: 'main',
        channel: CCS && typeof CCS.processRequest === 'function' ? 'ChatCompletionService' : 'TavernHelper',
        model,
        max_tokens: maxTokens ?? 'preset',
    });

    if (CCS && typeof CCS.processRequest === 'function') {
        const firstPathController = new AbortController();
        let forwardAbort = null;
        if (signal) {
            if (signal.aborted) firstPathController.abort();
            else {
                forwardAbort = () => firstPathController.abort();
                signal.addEventListener('abort', forwardAbort, { once: true });
            }
        }
        let timeoutId;
        let rejectTimeout;
        const armTimeout = (milliseconds, code) => {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => rejectTimeout?.(createDiagnosticError(REQUEST_DIAGNOSTIC_SIGNAL.TIMEOUT, {
                code, phase: 'main', transport: 'ChatCompletionService',
            })), milliseconds);
        };
        const firstAwareChunk = text => {
            if (String(text || '').trim() && shouldStream) {
                armTimeout(MAIN_STREAM_IDLE_TIMEOUT_MS, 'MAIN_STREAM_IDLE_TIMEOUT');
            }
            emitReasoningSafeChunk(onChunk, text);
        };
        try {
            const timeout = new Promise((_, reject) => {
                rejectTimeout = reject;
                armTimeout(
                    shouldStream ? MAIN_FIRST_TOKEN_TIMEOUT_MS : MAIN_RESPONSE_TIMEOUT_MS,
                    shouldStream ? 'MAIN_FIRST_TOKEN_TIMEOUT' : 'MAIN_RESPONSE_TIMEOUT',
                );
            });
            const result = await Promise.race([
                callViaChatCompletionService({
                    CCS,
                    messages: finalMessages,
                    maxTokens,
                    signal: firstPathController.signal,
                    onChunk: firstAwareChunk,
                    shouldStream,
                    ctx,
                    getContext,
                    onRequest,
                    presetName,
                    postProcessing,
                }),
                timeout,
            ]);
            const finalized = reasoningSafeResult(result, { phase: 'main', transport: 'ChatCompletionService' });
            onResponse({
                transport: 'ChatCompletionService', protocol: API_PROTOCOLS.OPENAI,
                httpStatus: null, contentType: 'sillytavern', format: 'sillytavern', events: null,
                hasText: true, hasReasoning: !!String(result?.reasoning || result?.state?.reasoning || '').trim(),
                rawStopReason: finalized.rawStopReason || null,
                usage: safeUsageSummary(finalized.usage || {}),
            });
            return finalized;
        } catch (error) {
            clearTimeout(timeoutId);
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            const safeError = normalizeMainApiFallbackError(error);
            if (shouldNotFallbackMainApi(safeError)) throw safeError;
            firstPathController.abort();
            onFallback('main:ChatCompletionService');
            log('warn', '主 API 请求路径降级', { from: 'ChatCompletionService', to: 'TavernHelper' });
            console.warn('[Theater] ChatCompletionService failed, fallback to TavernHelper:', safeError?.code || safeError?.name || 'unknown');
            if (tavernHelper && typeof tavernHelper.generateRaw === 'function') {
                onPath('main:TavernHelper');
                const result = await callViaGenerateRaw({
                    tavernHelper, messages: finalMessages, signal,
                    onChunk: text => emitReasoningSafeChunk(onChunk, text),
                    shouldStream,
                    onRequest,
                    model,
                    presetName,
                    postProcessing,
                });
                const finalized = reasoningSafeResult(result, { phase: 'main', transport: 'TavernHelper' });
                onResponse({
                    transport: 'TavernHelper', protocol: API_PROTOCOLS.OPENAI,
                    httpStatus: null, contentType: 'sillytavern', format: 'sillytavern', events: null,
                    hasText: true, hasReasoning: !!String(result?.reasoning || result?.state?.reasoning || '').trim(),
                    rawStopReason: finalized.rawStopReason || null,
                    usage: safeUsageSummary(finalized.usage || {}),
                });
                return finalized;
            }
            throwFriendlyMainApi(safeError, onChunk);
        } finally {
            clearTimeout(timeoutId);
            if (forwardAbort) signal?.removeEventListener('abort', forwardAbort);
        }
    }

    if (!tavernHelper || typeof tavernHelper.generateRaw !== 'function') {
        throw createDiagnosticError(REQUEST_DIAGNOSTIC_SIGNAL.CONFIG, {
            code: 'THEATER_CONFIG', phase: 'main', transport: 'TavernHelper',
        });
    }
    onPath('main:TavernHelper');
    const result = await callViaGenerateRaw({
        tavernHelper, messages: finalMessages, signal,
        onChunk: text => emitReasoningSafeChunk(onChunk, text),
        shouldStream,
        onRequest,
        model,
        presetName,
        postProcessing,
    });
    const finalized = reasoningSafeResult(result, { phase: 'main', transport: 'TavernHelper' });
    onResponse({
        transport: 'TavernHelper', protocol: API_PROTOCOLS.OPENAI,
        httpStatus: null, contentType: 'sillytavern', format: 'sillytavern', events: null,
        hasText: true, hasReasoning: !!String(result?.reasoning || result?.state?.reasoning || '').trim(),
        rawStopReason: finalized.rawStopReason || null,
        usage: safeUsageSummary(finalized.usage || {}),
    });
    return finalized;
}

export async function callViaChatCompletionService({
    CCS,
    messages,
    maxTokens,
    signal,
    onChunk = noop,
    shouldStream = true,
    ctx,
    getContext = () => globalThis.SillyTavern?.getContext?.(),
    onRequest = noop,
    presetName = '',
    postProcessing = '',
} = {}) {
    const currentContext = getContext?.() || ctx;
    const currentOai = currentContext?.oai_settings;
    const ctxOai = ctx?.oai_settings;
    const globalOai = globalThis.oai_settings;
    const oai = currentOai || ctxOai || globalOai;
    const source = currentOai?.chat_completion_source
        || ctxOai?.chat_completion_source
        || globalOai?.chat_completion_source;
    const model = resolveMainApiModel(currentContext, currentOai)
        || resolveMainApiModel(ctx, ctxOai)
        || resolveMainApiModel({}, globalOai);
    if (!source || !model) {
        throw createDiagnosticError(REQUEST_DIAGNOSTIC_SIGNAL.CONFIG, {
            // 这里只能说明当前版本的 ChatCompletionService 字段没有被识别；
            // TavernHelper 仍可能完整继承酒馆当前连接，因此允许安全降级一次。
            code: 'THEATER_MAIN_CONTEXT_UNRECOGNIZED', phase: 'main', transport: 'ChatCompletionService',
        });
    }

    onRequest({
        route: 'main', transport: 'ChatCompletionService', protocol: API_PROTOCOLS.OPENAI,
        model, presetName, postProcessing, maxTokens, messages,
    });
    const result = await CCS.processRequest(
        {
            messages: messages.map(message => ({ role: message.role, content: message.content })),
            model,
            chat_completion_source: source,
            ...(Number(maxTokens) > 0 ? { max_tokens: maxTokens } : {}),
            stream: shouldStream,
            // 消息角色与后处理已由插件按所选预设完成；显式覆盖这些字段，
            // 只让酒馆补齐连接与采样器，不把工具或结构化输出带回创作请求。
            custom_prompt_post_processing: '',
            tools: undefined,
            tool_choice: undefined,
            functions: undefined,
            function_call: undefined,
            json_schema: undefined,
            response_format: undefined,
        },
        { presetName },
        true,
        signal,
    );

    if (typeof result === 'function') {
        return await consumeStreamThunk(result, onChunk);
    }

    const meta = extractResponseMeta(typeof result === 'object' ? result : {}, API_PROTOCOLS.OPENAI);
    const text = typeof result === 'string'
        ? result
        : (result?.text || result?.content || result?.choices?.[0]?.message?.content || '');
    if (!text && String(result?.reasoning || result?.state?.reasoning || '').trim()) {
        throw reasoningOnlyError({ phase: 'main', transport: 'ChatCompletionService' });
    }
    if (!text) throw noTextResponseError(meta, { phase: 'main', transport: 'ChatCompletionService' });
    onChunk(text);
    return { text, ...meta };
}

export async function consumeStreamThunk(streamThunk, onChunk = noop) {
    let full = '';
    let meta = { stopReason: 'unknown', rawStopReason: null, usage: null };
    let hadReasoning = false;
    for await (const chunk of streamThunk()) {
        const cumulativeText = typeof chunk === 'object' && typeof chunk?.text === 'string'
            ? chunk.text
            : null;
        const delta = cumulativeText === null
            ? (typeof chunk === 'string' ? chunk : extractStreamText(chunk, API_PROTOCOLS.OPENAI))
            : '';
        if (typeof chunk === 'object') {
            const nextMeta = extractResponseMeta(chunk, API_PROTOCOLS.OPENAI);
            if (nextMeta.rawStopReason) meta = nextMeta;
            else if (nextMeta.usage) meta.usage = nextMeta.usage;
            hadReasoning ||= hasReasoningContent(chunk) || !!String(chunk?.state?.reasoning || '').trim();
        }
        if (cumulativeText !== null && cumulativeText !== full) {
            full = cumulativeText;
            onChunk(full);
        } else if (delta) {
            full += delta;
            onChunk(full);
        }
    }
    if (!full && hadReasoning) throw reasoningOnlyError({ phase: 'main', transport: 'stream' });
    if (!full) throw noTextResponseError(meta, { phase: 'main', transport: 'stream' });
    return { text: full, ...meta };
}

export function throwFriendlyMainApi(error, onChunk = noop) {
    if (error?.name === 'AbortError') throw error;
    if (error?.diagnosticSignal) throw error;
    const message = String(error?.message || error || '');
    if (isContentBlockedErrorMessage(message)) {
        throw createDiagnosticError(REQUEST_DIAGNOSTIC_SIGNAL.CONTENT_FILTER, {
            code: 'THEATER_CONTENT_FILTER', phase: 'main', transport: 'TavernHelper',
        });
    }
    if (isRateLimitErrorMessage(message)) {
        throw createDiagnosticError(REQUEST_DIAGNOSTIC_SIGNAL.RATE_LIMIT, {
            code: 'THEATER_RATE_LIMIT', phase: 'main', transport: 'TavernHelper',
        });
    }
    if (/max[_\s-]?tokens|max(?:imum)?\s+(?:output|context)|输出上限|上下文上限/i.test(message)) {
        throw createDiagnosticError(REQUEST_DIAGNOSTIC_SIGNAL.TOKEN_LIMIT, {
            code: 'THEATER_OUTPUT_LIMIT', phase: 'main', transport: 'TavernHelper',
        });
    }
    if (/api[_\s]?key[_\s]?missing|401|unauthorized/i.test(message)) {
        throw createDiagnosticError(REQUEST_DIAGNOSTIC_SIGNAL.CONFIG, {
            code: 'THEATER_CONFIG', phase: 'main', transport: 'TavernHelper',
        });
    }
    if (/502|524|529|gateway|timeout|ECONNRESET|socket hang up/i.test(message)) {
        throw createDiagnosticError(REQUEST_DIAGNOSTIC_SIGNAL.TIMEOUT, {
            code: 'THEATER_MAIN_GATEWAY', phase: 'main', transport: 'TavernHelper',
        });
    }
    throw createDiagnosticError(REQUEST_DIAGNOSTIC_SIGNAL.UNKNOWN, {
        code: 'THEATER_MAIN_UNKNOWN', phase: 'main', transport: 'TavernHelper',
    });
}

export async function callViaGenerateRaw({
    tavernHelper,
    messages,
    signal,
    onChunk = noop,
    shouldStream = true,
    onRequest = noop,
    model = '',
    presetName = '',
    postProcessing = '',
} = {}) {
    const timeoutMs = 5 * 60 * 1000;
    let abortHandler = null;
    let timeoutId = null;
    const abortPromise = signal
        ? new Promise((_, reject) => {
            if (signal.aborted) reject(new DOMException('Aborted', 'AbortError'));
            else {
                abortHandler = () => reject(new DOMException('Aborted', 'AbortError'));
                signal.addEventListener('abort', abortHandler, { once: true });
            }
        })
        : new Promise(() => {});
    const timeoutPromise = new Promise((_, reject) =>
        { timeoutId = setTimeout(() => reject(createDiagnosticError(REQUEST_DIAGNOSTIC_SIGNAL.TIMEOUT, {
            code: 'THEATER_MAIN_TIMEOUT', phase: 'main', transport: 'TavernHelper',
        })), timeoutMs); }
    );

    try {
        onRequest({
            route: 'main', transport: 'TavernHelper', protocol: API_PROTOCOLS.OPENAI,
            model, presetName, postProcessing, maxTokens: null, messages,
        });
        const result = await Promise.race([
            tavernHelper.generateRaw({
                user_input: '',
                ordered_prompts: messages,
                overrides: {
                    world_info_before: '', world_info_after: '',
                    persona_description: '', char_description: '',
                    char_personality: '', scenario: '',
                    dialogue_examples: '',
                    chat_history: { prompts: [], with_depth_entries: false, author_note: '' },
                },
                injects: [],
                max_chat_history: 0,
                should_stream: shouldStream,
                signal,
            }),
            abortPromise,
            timeoutPromise,
        ]);
        if (!result) throw noTextResponseError({}, { phase: 'main', transport: 'TavernHelper' });
        const text = typeof result === 'string' ? result : (result?.text || result?.content || '');
        const meta = extractResponseMeta(typeof result === 'object' ? result : {}, API_PROTOCOLS.OPENAI);
        if (!text && String(result?.reasoning || result?.state?.reasoning || '').trim()) {
            throw reasoningOnlyError({ phase: 'main', transport: 'TavernHelper' });
        }
        if (!text) throw noTextResponseError(meta, { phase: 'main', transport: 'TavernHelper' });
        onChunk(text);
        return { text, ...meta };
    } catch (error) {
        if (error?.name === 'AbortError') throw error;
        throwFriendlyMainApi(error, onChunk);
    } finally {
        clearTimeout(timeoutId);
        if (abortHandler) signal?.removeEventListener('abort', abortHandler);
    }
}

export function waitForApiRetry(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
        }
        let timer = null;
        const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
        };
        timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

export async function retryRateLimitedResponse(response, retryRequest, details = {}, {
    signal,
    log = noop,
} = {}) {
    if (response.status !== 429) return { response, retried: false };
    const requestedWait = retryAfterMilliseconds(response.headers.get('retry-after')) ?? RATE_LIMIT_DEFAULT_WAIT_MS;
    if (requestedWait > RATE_LIMIT_MAX_AUTO_WAIT_MS) {
        log('warn', '接口请求较多，建议稍后重试', { ...details, retry_after_ms: requestedWait, auto_retry: false });
        return { response, retried: false };
    }
    log('warn', '接口暂时繁忙，当前轮等待后重试一次', { ...details, retry_after_ms: requestedWait, auto_retry: true });
    await waitForApiRetry(requestedWait, signal);
    return { response: await retryRequest(), retried: true };
}

export async function customApiStatusError(response, label = 'API') {
    const body = await response.text().catch(() => '');
    return statusError(response.status, body, { phase: label, transport: 'non_stream' });
}

export async function requestCustomApi({
    config = {},
    systemPrompt,
    userPrompt,
    messages,
    postProcessing = '',
    presetName = '',
    onChunk = noop,
    onRequest = noop,
    shouldStream = true,
    signal,
    log = noop,
    onFallback = noop,
    onResponse = noop,
    fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
    const url = String(config.apiUrl || '').replace(/\/+$/, '');
    const candidates = maxTokenFallbackSequence(config.maxOutputTokens);
    const safeChunk = text => emitReasoningSafeChunk(onChunk, text);
    const reportResponse = (summary = {}) => {
        const safeSummary = { ...summary };
        onResponse(safeSummary);
        log(safeSummary.hasText ? 'info' : 'warn', '接口响应摘要', safeSummary);
    };
    const finalize = (result, transport) => {
        reportResponse(result?.responseSummary || {});
        return publicResult(reasoningSafeResult(result, { phase: 'body', transport }));
    };
    for (let index = 0; index < candidates.length; index++) {
        const maxTokens = candidates[index];
        const request = buildApiRequest({
            url,
            protocol: config.apiProtocol || API_PROTOCOLS.AUTO,
            key: config.apiKey,
            model: config.apiModel,
            systemPrompt,
            userPrompt,
            messages,
            postProcessing,
            maxTokens,
            stream: shouldStream,
        });
        if (request.protocol === API_PROTOCOLS.ANTHROPIC && !config.apiKey) {
            throw createDiagnosticError(REQUEST_DIAGNOSTIC_SIGNAL.CONFIG, {
                code: 'THEATER_CONFIG', phase: 'body', transport: request.protocol,
            });
        }
        log('info', '请求发出', {
            mode: 'custom', url: request.endpoint, protocol: request.protocol, max_tokens: maxTokens,
            preset_generation_options: 'not_inherited',
            message_compatibility: request.messageCompatibility,
        });
        onRequest({
            route: 'custom', transport: shouldStream ? 'stream' : 'non-stream', protocol: request.protocol,
            model: config.apiModel, presetName, postProcessing, maxTokens, messages: request.messages,
            presetGenerationOptionsInherited: false,
            messageCompatibility: request.messageCompatibility,
        });
        const performRequest = body => fetchImpl(request.endpoint, {
            method: 'POST',
            headers: request.headers,
            body: JSON.stringify(body),
            signal,
        });
        let response;
        try {
            response = await performCustomFetch(() => performRequest(request.body), {
                phase: 'body', transport: request.protocol,
            });
        } catch (error) {
            throw normalizeFetchError(error, { phase: 'body', transport: request.protocol });
        }
        let rateLimitRetried = false;
        const rateLimitResult = await retryRateLimitedResponse(response, () => performCustomFetch(
            () => performRequest(request.body),
            { phase: 'body', transport: request.protocol },
        ), {
            protocol: request.protocol,
            max_tokens: maxTokens,
        }, { signal, log });
        response = rateLimitResult.response;
        rateLimitRetried = rateLimitResult.retried;
        if (!response.ok) {
            const errorBody = await response.text().catch(() => '');
            const nextLimit = candidates[index + 1];
            if (nextLimit && isMaxTokenLimitError(response.status, errorBody)) {
                log('warn', '模型拒绝单轮输出上限，自动降低后重试', { status: response.status, from: maxTokens, to: nextLimit });
                onFallback(`custom:max-token ${maxTokens}→${nextLimit}`);
                continue;
            }
            throw statusError(response.status, errorBody, { phase: 'body', transport: request.protocol });
        }
        if (shouldStream) {
            while (true) {
                try {
                    return finalize(await readSSEStream(response, safeChunk, request.protocol), request.protocol);
                } catch (streamError) {
                    if (streamError?.apiResponseSummary) reportResponse(streamError.apiResponseSummary);
                    if (streamError?.code === 'THEATER_RATE_LIMIT' && !rateLimitRetried) {
                        rateLimitRetried = true;
                        log('warn', '接口在流内报告限流，当前轮等待后重试一次', {
                            protocol: request.protocol,
                            max_tokens: maxTokens,
                            retry_after_ms: RATE_LIMIT_DEFAULT_WAIT_MS,
                        });
                        await waitForApiRetry(RATE_LIMIT_DEFAULT_WAIT_MS, signal);
                        response = await performCustomFetch(() => performRequest(request.body), {
                            phase: 'body', transport: request.protocol,
                        });
                        if (!response.ok) throw await customApiStatusError(response);
                        continue;
                    }
                    if (streamError?.code !== 'THEATER_STREAM_EMPTY') throw streamError;
                    onFallback('custom:stream→non-stream');
                    log('warn', '流式返回为空，当前轮自动改用非流式重试', {
                        protocol: request.protocol,
                        max_tokens: maxTokens,
                        fallback: 'non_stream',
                    });
                    log('info', '请求发出', {
                        mode: 'custom',
                        url: request.endpoint,
                        protocol: request.protocol,
                        max_tokens: maxTokens,
                        transport: 'non_stream_fallback',
                        message_compatibility: request.messageCompatibility,
                    });
                    onRequest({
                        route: 'custom', transport: 'non-stream-fallback', protocol: request.protocol,
                        model: config.apiModel, presetName, postProcessing, maxTokens, messages: request.messages,
                        presetGenerationOptionsInherited: false,
                        messageCompatibility: request.messageCompatibility,
                    });
                    const fallbackBody = { ...request.body, stream: false };
                    let fallbackResponse = await performCustomFetch(() => performRequest(fallbackBody), {
                        phase: 'body', transport: 'non_stream_fallback',
                    });
                    if (!rateLimitRetried) {
                        const fallbackRateLimit = await retryRateLimitedResponse(fallbackResponse, () => performCustomFetch(
                            () => performRequest(fallbackBody),
                            { phase: 'body', transport: 'non_stream_fallback' },
                        ), {
                            protocol: request.protocol,
                            max_tokens: maxTokens,
                            transport: 'non_stream_fallback',
                        }, { signal, log });
                        fallbackResponse = fallbackRateLimit.response;
                        rateLimitRetried = fallbackRateLimit.retried;
                    }
                    if (!fallbackResponse.ok) {
                        throw await customApiStatusError(fallbackResponse, 'API 非流式重试');
                    }
                    return finalize(await readNonStreamingResponse(fallbackResponse, safeChunk, request.protocol), request.protocol);
                }
            }
        }
        return finalize(await readNonStreamingResponse(response, safeChunk, request.protocol), request.protocol);
    }
    throw createDiagnosticError(REQUEST_DIAGNOSTIC_SIGNAL.TOKEN_LIMIT, {
        code: 'THEATER_OUTPUT_LIMIT', phase: 'body', transport: 'custom',
    });
}

function htmlResponseError(raw) {
    return createDiagnosticError(REQUEST_DIAGNOSTIC_SIGNAL.INVALID_RESPONSE, {
        code: 'THEATER_RESPONSE_HTML', phase: 'body', transport: 'response',
    });
}

function streamPayloadError(message) {
    if (isContentBlockedErrorMessage(message)) {
        return createDiagnosticError(REQUEST_DIAGNOSTIC_SIGNAL.CONTENT_FILTER, {
            code: 'THEATER_CONTENT_FILTER', rawStopReason: message, phase: 'body', transport: 'stream',
        });
    }
    if (isRateLimitErrorMessage(message)) {
        return createDiagnosticError(REQUEST_DIAGNOSTIC_SIGNAL.RATE_LIMIT, {
            code: 'THEATER_RATE_LIMIT', phase: 'body', transport: 'stream',
        });
    }
    return createDiagnosticError(REQUEST_DIAGNOSTIC_SIGNAL.INVALID_RESPONSE, {
        code: 'THEATER_RESPONSE_PARSE', phase: 'body', transport: 'stream',
    });
}

export async function readNonStreamingResponse(response, onChunk = noop, protocol = API_PROTOCOLS.OPENAI) {
    const raw = await response.text();
    if (isHtmlErrorResponse(response.headers.get('content-type'), raw)) throw htmlResponseError(raw);
    const trimmed = raw.trim();
    if (!trimmed) throw noTextResponseError({}, { phase: 'body', transport: 'non_stream' });

    let text = trimmed;
    let meta = { stopReason: 'unknown', rawStopReason: null, usage: null };
    let responseSummary = createResponseSummary({ response, transport: 'non_stream', protocol });
    try {
        const json = JSON.parse(trimmed);
        const apiError = extractApiErrorMessage(json);
        if (apiError) throw streamPayloadError(apiError);
        text = extractStreamText(json, protocol);
        meta = extractResponseMeta(json, protocol);
        responseSummary = createResponseSummary({
            response, transport: 'non_stream', protocol, events: 1, json, meta,
            hasText: !!text, hasReasoning: hasReasoningContent(json),
        });
        if (!text && responseSummary.hasReasoning) {
            throw attachResponseSummary(reasoningOnlyError({ phase: 'body', transport: 'non_stream' }), responseSummary);
        }
        if (!text) throw attachResponseSummary(noTextResponseError(meta, { phase: 'body', transport: 'non_stream' }), responseSummary);
    } catch (error) {
        if (error instanceof SyntaxError) text = trimmed;
        else throw error;
    }
    onChunk(text);
    responseSummary.hasText = !!text;
    return { text, ...meta, responseSummary };
}

function streamIdleTimeoutError() {
    return createDiagnosticError(REQUEST_DIAGNOSTIC_SIGNAL.TIMEOUT, {
        code: 'THEATER_STREAM_IDLE_TIMEOUT', phase: 'body', transport: 'stream',
    });
}

async function readStreamChunk(reader, idleTimeoutMs) {
    const timeout = Math.max(0, Number(idleTimeoutMs) || 0);
    if (!timeout) return reader.read();
    let timeoutId = null;
    try {
        return await Promise.race([
            reader.read(),
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(streamIdleTimeoutError()), timeout);
            }),
        ]);
    } catch (error) {
        if (error?.code === 'THEATER_STREAM_IDLE_TIMEOUT') {
            await reader.cancel('stream idle timeout').catch(() => {});
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

export async function readSSEStream(
    response,
    onChunk = noop,
    protocol = API_PROTOCOLS.OPENAI,
    { idleTimeoutMs = CUSTOM_STREAM_IDLE_TIMEOUT_MS } = {},
) {
    const contentType = response.headers.get('content-type') || '';
    if (isHtmlErrorResponse(contentType)) throw htmlResponseError(await response.text());
    if (!response.body?.getReader) {
        throw streamEmptyError();
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let full = '', buffer = '', rawText = '';
    let eventData = [];
    let meta = { stopReason: 'unknown', rawStopReason: null, usage: null };
    let providerError = '';
    let hadReasoning = false;
    let eventCount = 0;
    let lastJson = null;
    let streamFinished = false;

    const consumePayload = (payload) => {
        const text = String(payload || '').trim();
        if (!text) return;
        if (text === '[DONE]') {
            streamFinished = true;
            return;
        }
        let json;
        try { json = JSON.parse(text); } catch { return; }
        eventCount += 1;
        lastJson = json;
        providerError ||= extractApiErrorMessage(json);
        hadReasoning ||= hasReasoningContent(json);
        const nextMeta = extractResponseMeta(json, protocol);
        if (nextMeta.rawStopReason) meta = nextMeta;
        else if (nextMeta.usage) meta.usage = nextMeta.usage;
        const delta = extractStreamText(json, protocol);
        if (delta) {
            full += delta;
            onChunk(full);
        }
    };

    const dispatchEvent = () => {
        if (!eventData.length) return;
        consumePayload(eventData.join('\n'));
        eventData = [];
    };

    const consumeLine = (line) => {
        if (line === '') {
            dispatchEvent();
            return;
        }
        if (line.startsWith(':') || line.startsWith('event:') || line.startsWith('id:') || line.startsWith('retry:')) return;
        if (line.startsWith('data:')) {
            const data = line.slice(5).replace(/^ /, '');
            if (data.trim() === '[DONE]') {
                dispatchEvent();
                consumePayload(data);
                return;
            }
            eventData.push(data);
            return;
        }
        const text = line.trim();
        if (text.startsWith('{') || text.startsWith('[')) consumePayload(text);
    };

    while (true) {
        const { done, value } = await readStreamChunk(reader, idleTimeoutMs);
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        rawText += chunk;
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';

        for (const line of lines) consumeLine(line.replace(/\r$/, ''));
        if (streamFinished) {
            await reader.cancel('stream completed').catch(() => {});
            break;
        }
    }
    const finalChunk = decoder.decode();
    rawText += finalChunk;
    buffer += finalChunk;
    if (buffer) consumeLine(buffer.replace(/\r$/, ''));
    dispatchEvent();

    if (!full && rawText.trim()) {
        try {
            const json = JSON.parse(rawText.trim());
            const apiError = extractApiErrorMessage(json);
            if (apiError) throw streamPayloadError(apiError);
            hadReasoning ||= hasReasoningContent(json);
            lastJson = json;
            eventCount = Math.max(1, eventCount);
            full = extractStreamText(json, protocol);
            if (full) {
                onChunk(full);
                const rawMeta = extractResponseMeta(json, protocol);
                return {
                    text: full,
                    ...rawMeta,
                    responseSummary: createResponseSummary({
                        response, transport: 'stream', protocol, events: eventCount, json, meta: rawMeta,
                        hasText: true, hasReasoning: hadReasoning,
                    }),
                };
            }
            const rawMeta = extractResponseMeta(json, protocol);
            if (rawMeta.rawStopReason || rawMeta.blockReason) meta = rawMeta;
        } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
        }
        const raw = rawText.trim();
        if (isHtmlErrorResponse(contentType, raw)) throw htmlResponseError(raw);
        if (raw.length > 20 && !raw.startsWith('{') && !raw.startsWith('data:')) {
            full = raw;
            onChunk(full);
        }
    }

    const responseSummary = createResponseSummary({
        response, transport: 'stream', protocol, events: eventCount, json: lastJson, meta,
        hasText: !!full, hasReasoning: hadReasoning,
    });
    if (!full && providerError) throw attachResponseSummary(streamPayloadError(providerError), responseSummary);
    if (!full && hadReasoning) {
        throw attachResponseSummary(reasoningOnlyError({ phase: 'body', transport: 'stream' }), responseSummary);
    }
    if (!full && (meta.blockReason || isContentBlockedStopReason(meta.rawStopReason))) {
        throw attachResponseSummary(noTextResponseError(meta, { phase: 'body', transport: 'stream' }), responseSummary);
    }
    // 已收到合法事件（尤其是 finish_reason），说明流式传输本身并不为空；
    // 此时再次完整生成只会重复消耗上游推理，直接报告无正文。
    if (!full && eventCount > 0) {
        throw attachResponseSummary(noTextResponseError(meta, { phase: 'body', transport: 'stream' }), responseSummary);
    }
    if (!full) throw attachResponseSummary(streamEmptyError(), responseSummary);
    return { text: full, ...meta, responseSummary };
}
