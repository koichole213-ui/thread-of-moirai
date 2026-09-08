export const REQUEST_DIAGNOSTIC_SIGNAL = Object.freeze({
    CONTENT_FILTER: 'T-API-CONTENT-FILTER',
    EMPTY: 'T-API-EMPTY',
    REASONING_ONLY: 'T-API-REASONING-ONLY',
    TRUNCATED: 'T-API-TRUNCATED',
    RATE_LIMIT: 'T-HTTP-429',
    HTTP_SERVER: 'T-HTTP-5XX',
    HTTP_CLIENT: 'T-HTTP-4XX',
    TIMEOUT: 'T-NET-TIMEOUT',
    NETWORK: 'T-NET-FAILED',
    TOKEN_LIMIT: 'T-API-TOKEN-LIMIT',
    INVALID_RESPONSE: 'T-API-INVALID-RESPONSE',
    RENDER_INVALID: 'T-RENDER-INVALID',
    CONFIG: 'T-API-CONFIG',
    AUTO_NO_INSTRUCTION: 'T-AUTO-NO-INSTRUCTION',
    UNKNOWN: 'T-UNKNOWN',
});

const CATALOG = Object.freeze({
    [REQUEST_DIAGNOSTIC_SIGNAL.CONTENT_FILTER]: {
        status: 'bad',
        title: '上游内容策略拦截',
        detail: '模型或 API 线路没有返回正文。这不等于本轮指令一定含 NSFW：上游会综合预设、角色设定、人设、聊天前文、世界书和补充判断。',
        action: '先查看“最近请求摘要”，确认是否有非必要的补充或上下文参与；不要尝试绕过线路保护。若认为是误判，可用合规的最小上下文复现后联系线路提供者。',
    },
    [REQUEST_DIAGNOSTIC_SIGNAL.EMPTY]: {
        status: 'bad',
        title: '接口没有返回可读正文',
        detail: '请求已得到响应，但其中没有可显示的正文，也没有明确的内容策略结束原因。',
        action: '检查“最近请求计时”和“自动恢复”。若流式兼容重试后仍为空，向线路提供者确认该模型是否支持当前协议与流式格式。',
    },
    [REQUEST_DIAGNOSTIC_SIGNAL.REASONING_ONLY]: {
        status: 'bad',
        title: '模型只返回了思考内容',
        detail: '插件已经隐藏模型输出中的 <thinking> / <think> 内容，但没有在标签外找到可保存的正文。思考内容不会进入小剧场、长梦、梦脉或备份。',
        action: '检查预设是否要求模型在思考标签后继续输出正文；必要时调整预设的输出结构后重新生成。',
    },
    [REQUEST_DIAGNOSTIC_SIGNAL.TRUNCATED]: {
        status: 'warn',
        title: '输出达到上限',
        detail: '模型在输出 Token 上限处结束；这不是空回，已收到的正文会被保留。',
        action: '可降低目标字数或上下文；若已开启自动补写，插件会按当前轮次策略继续。',
    },
    [REQUEST_DIAGNOSTIC_SIGNAL.RATE_LIMIT]: {
        status: 'warn',
        title: '接口限流或配额不足',
        detail: 'HTTP 429 表示线路暂时拒绝了请求，常见于并发过高、配额耗尽或上游拥堵；插件只会在可等待的 Retry-After 范围内自动重试一次。',
        action: '稍后再试即可，不需要重填 Key；若持续发生，请检查线路配额、并发或服务商状态。',
    },
    [REQUEST_DIAGNOSTIC_SIGNAL.HTTP_SERVER]: {
        status: 'bad',
        title: '上游或中转服务器异常',
        detail: 'HTTP 5xx（例如 T-HTTP-500、502、503、504）通常来自模型服务、网关或中转临时故障，不能据此判断是用户指令或 Key 有问题。',
        action: '稍后重试；若连续出现，换到服务商确认可用的模型/线路，或向服务商提供错误时间和信号。',
        aliases: ['T-HTTP-500', 'T-HTTP-502', 'T-HTTP-503', 'T-HTTP-504'],
    },
    [REQUEST_DIAGNOSTIC_SIGNAL.HTTP_CLIENT]: {
        status: 'bad',
        title: '接口拒绝当前请求',
        detail: 'HTTP 4xx（除 429 外）通常表示认证、模型名、请求参数或线路规则不接受当前请求。',
        action: '检查 API URL、模型名、协议和服务商要求；不要在诊断或截图中粘贴 Key。',
        aliases: ['T-HTTP-400', 'T-HTTP-401', 'T-HTTP-403', 'T-HTTP-404', 'T-HTTP-422'],
    },
    [REQUEST_DIAGNOSTIC_SIGNAL.TIMEOUT]: {
        status: 'bad',
        title: '请求等待超时',
        detail: '在等待首字、流式续传或完整响应时超过了可等待时间。',
        action: '检查线路繁忙程度、网络和模型响应时间；已收到的正文会优先保留。',
    },
    [REQUEST_DIAGNOSTIC_SIGNAL.NETWORK]: {
        status: 'bad',
        title: '网络连接没有完成',
        detail: '浏览器没有取得可读取的接口响应，常见于网络中断、跨域限制、代理断开或上游连接被重置。',
        action: '先确认同一地址在当前网络可用；若酒馆正文正常而独立 API 持续失败，请复制脱敏日志中的时间与信号给线路提供者。',
    },
    [REQUEST_DIAGNOSTIC_SIGNAL.TOKEN_LIMIT]: {
        status: 'bad',
        title: '线路拒绝输出或上下文上限',
        detail: '模型不接受当前输出/上下文 Token 上限，或聊天前文、系统预设、角色设定与世界书合计塞满了上下文窗口。',
        action: '先减少聊天前文条数和非必要世界书/预设内容，再降低目标字数或最大输出 Token；同时确认模型支持的上下文与输出上限。',
    },
    [REQUEST_DIAGNOSTIC_SIGNAL.INVALID_RESPONSE]: {
        status: 'bad',
        title: '接口响应格式不兼容',
        detail: '线路返回了无法按当前协议读取的响应，例如 HTML 错误页或非预期 JSON。',
        action: '检查独立 API 协议是否选对（OpenAI / Anthropic / 自动），以及中转是否兼容该格式。',
    },
    [REQUEST_DIAGNOSTIC_SIGNAL.RENDER_INVALID]: {
        status: 'warn',
        title: '最终 HTML 排版未通过校验',
        detail: '正文已经生成，但最终 HTML 缺段、重复或不完整；插件会保留可读正文。',
        action: '可更换渲染模板后重试；无需重新生成已经保留的正文。',
    },
    [REQUEST_DIAGNOSTIC_SIGNAL.CONFIG]: {
        status: 'bad',
        title: 'API 配置不完整',
        detail: '当前模式缺少可用的 URL、模型、Key 或酒馆主 API 选择。',
        action: '在“设置”或酒馆 API 设置中补齐配置，再重新生成。',
    },
    [REQUEST_DIAGNOSTIC_SIGNAL.AUTO_NO_INSTRUCTION]: {
        status: 'warn',
        title: '自动模式没有可用指令',
        detail: '自动模式达到楼层间隔，但所选指令来源为空，因此本次没有发出 API 请求。',
        action: '先手动生成一次以保存“上次使用的指令”，或把自动来源切到含正文的模板范围。',
    },
    [REQUEST_DIAGNOSTIC_SIGNAL.UNKNOWN]: {
        status: 'bad',
        title: '未分类的插件请求错误',
        detail: '插件没有取得足以归类的安全状态信息。',
        action: '复制诊断报告和脱敏运行日志，并附上出现的错误信号。',
    },
});

export function safeDiagnosticReason(value) {
    const text = String(value || '').trim().toLowerCase();
    if (!text || text.length > 80) return null;
    return /^[a-z0-9_.:-]+$/.test(text) ? text : null;
}

export function diagnosticSignalInfo(signal) {
    if (/^T-HTTP-5\d\d$/.test(String(signal || ''))) return CATALOG[REQUEST_DIAGNOSTIC_SIGNAL.HTTP_SERVER];
    if (/^T-HTTP-4\d\d$/.test(String(signal || ''))) return CATALOG[REQUEST_DIAGNOSTIC_SIGNAL.HTTP_CLIENT];
    return CATALOG[signal] || CATALOG[REQUEST_DIAGNOSTIC_SIGNAL.UNKNOWN];
}

export function diagnosticSignalCatalog() {
    return Object.entries(CATALOG).map(([signal, info]) => ({ signal, ...info }));
}

export function createDiagnosticError(signal, {
    code = '',
    rawStopReason = null,
    status = null,
    phase = '',
    transport = '',
} = {}) {
    const error = new Error(signal);
    error.name = 'TheaterRequestError';
    error.code = code || signal;
    error.diagnosticSignal = signal;
    error.theaterFailure = {
        signal,
        rawStopReason: safeDiagnosticReason(rawStopReason),
        status: Number.isFinite(Number(status)) ? Number(status) : null,
        phase: String(phase || ''),
        transport: String(transport || ''),
    };
    return error;
}

export function classifyRequestFailure(error, { stage = '正文生成' } = {}) {
    const code = String(error?.code || '');
    const message = String(error?.message || error || '');
    const failure = error?.theaterFailure || {};
    const httpStatus = Number.isFinite(Number(failure.status)) ? Number(failure.status) : null;
    let signal = error?.diagnosticSignal || failure.signal || '';

    if (!CATALOG[signal] && !/^T-HTTP-[45]\d\d$/.test(signal)) {
        const statusFromMessage = `${code} ${message}`.match(/\b([45]\d\d)\b/);
        if (httpStatus === 429) {
            signal = REQUEST_DIAGNOSTIC_SIGNAL.RATE_LIMIT;
        } else if (httpStatus >= 400 && httpStatus <= 599) {
            signal = `T-HTTP-${httpStatus}`;
        } else if (statusFromMessage?.[1] === '429') {
            signal = REQUEST_DIAGNOSTIC_SIGNAL.RATE_LIMIT;
        } else if (statusFromMessage?.[1]) {
            signal = `T-HTTP-${statusFromMessage[1]}`;
        } else if (code === 'THEATER_CONTENT_FILTER' || /content[_\s-]*filter|\b(?:safety|blocklist|spii|recitation|prohibited_content)\b/i.test(message)) {
            signal = REQUEST_DIAGNOSTIC_SIGNAL.CONTENT_FILTER;
        } else if (code === 'THEATER_RATE_LIMIT' || /\b429\b|rate[\s_-]*limit|quota|请求过于频繁|限流/i.test(message)) {
            signal = REQUEST_DIAGNOSTIC_SIGNAL.RATE_LIMIT;
        } else if (/TIMEOUT|超时|gateway|\b(?:502|503|504|524|529)\b/i.test(`${code} ${message}`)) {
            signal = REQUEST_DIAGNOSTIC_SIGNAL.TIMEOUT;
        } else if (code === 'THEATER_NETWORK_FAILED' || /failed to fetch|network(?:error| error)|load failed|connection reset|econnreset|socket hang up/i.test(message)) {
            signal = REQUEST_DIAGNOSTIC_SIGNAL.NETWORK;
        } else if (code === 'THEATER_OUTPUT_LIMIT' || /max[_\s-]?tokens|max(?:imum)?\s+(?:output|context)|输出上限|上下文上限|上下文(?:窗口|长度)?(?:已满|超出)|减少对话历史/i.test(message)) {
            signal = REQUEST_DIAGNOSTIC_SIGNAL.TOKEN_LIMIT;
        } else if (['THEATER_STREAM_EMPTY', 'THEATER_RESPONSE_EMPTY'].includes(code) || /返回空内容|没有可识别的正文|没有返回内容/i.test(message)) {
            signal = REQUEST_DIAGNOSTIC_SIGNAL.EMPTY;
        } else if (['THEATER_PLACEHOLDER_INVALID', 'THEATER_RENDER_VALIDATION'].includes(code)) {
            signal = REQUEST_DIAGNOSTIC_SIGNAL.RENDER_INVALID;
        } else if (/API URL|API Key|模型|source|主 API|配置/i.test(message)) {
            signal = REQUEST_DIAGNOSTIC_SIGNAL.CONFIG;
        } else if (/HTML 错误页|响应格式|解析|JSON/i.test(message)) {
            signal = REQUEST_DIAGNOSTIC_SIGNAL.INVALID_RESPONSE;
        } else {
            signal = REQUEST_DIAGNOSTIC_SIGNAL.UNKNOWN;
        }
    }

    const info = diagnosticSignalInfo(signal);
    return {
        signal,
        status: info.status,
        title: info.title,
        detail: info.detail,
        action: info.action,
        stage: String(stage || '正文生成'),
        rawStopReason: safeDiagnosticReason(failure.rawStopReason || error?.rawStopReason),
        httpStatus,
    };
}

export function signalForStopReason(stopReason) {
    const value = safeDiagnosticReason(stopReason);
    return ['length', 'max_tokens', 'max_tokens_reached'].includes(value)
        ? REQUEST_DIAGNOSTIC_SIGNAL.TRUNCATED
        : null;
}
