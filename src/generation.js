import { clone, parseResult, RequestGate } from './core.js';
import { buildMessages } from './references.js';
import { requestCustomApi, requestMainApi } from '../vendor/st-theater/api-runtime.js';

export function routeFor(settings, task, revision) {
    const secondary = task === 'choices' && revision && settings.secondaryEnabled;
    return secondary ? { route: 'custom', profile: settings.secondary } : { route: settings.route, profile: settings.primary };
}
export class Generator {
    constructor(host, { main = requestMainApi, custom = requestCustomApi } = {}) { this.host = host; this.main = main; this.custom = custom; this.gate = new RequestGate(); }
    cancel() { this.gate.cancel(); }
    async generate({ state, settings, task, count, instruction = '', revised = false, onChunk = () => {} }) {
        const identity = this.host.identity(), snapshot = clone(state), config = clone(settings);
        if (!identity) throw new Error('请先打开一个聊天。');
        const token = this.gate.start(identity, state.revision);
        const refs = await this.host.references(config);
        const valid = () => this.gate.valid(token, this.host.identity(), state.revision);
        if (!valid()) throw new DOMException('已取消', 'AbortError');
        const messages = buildMessages({ settings: config, refs, state: snapshot, task, count, instruction });
        const route = routeFor(config, task, revised);
        const args = { messages, signal: token.signal, shouldStream: route.profile.stream,
            onChunk: text => { if (valid()) onChunk(text); } };
        let response;
        if (route.route === 'custom') {
            const p = route.profile;
            if (!p.endpoint || !p.model) throw new Error('请在参考与生成设置中填写 API 地址和模型。');
            const url = new URL(p.endpoint);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('API 地址需是 HTTP(S) 地址，且不能包含账号或密码。');
            response = await this.custom({ ...args, config: { apiUrl: p.endpoint, apiModel: p.model, apiProtocol: p.protocol, apiKey: this.host.credentials.get(p.credentialId) || '' } });
        } else {
            const ctx = this.host.getContext();
            if (ctx.mainApi !== 'openai') throw new Error('此版本的酒馆主 API 接入需要“聊天补全”连接。也可以在本插件选择独立 API。');
            args.shouldStream = ctx.chatCompletionSettings?.stream_openai !== false;
            response = await this.main({ ...args, ctx: { ...ctx, oai_settings: ctx.chatCompletionSettings }, getContext: this.host.getContext });
        }
        if (!valid()) throw new DOMException('已取消', 'AbortError');
        return { items: parseResult(typeof response === 'string' ? response : response.text, task === 'choices' ? 'choices' : 'stages', count), token };
    }
}
