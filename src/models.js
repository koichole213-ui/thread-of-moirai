// Same endpoint/header/list semantics as 千夜浮梦's fetchModelList.
import { buildApiEndpoint, resolveProtocol } from '../vendor/st-theater/api-client.js';

export async function fetchModels(profile, key = '', { signal, request = fetch } = {}) {
    let url;
    try { url = new URL(profile.endpoint.trim()); } catch { throw new Error('请先填写有效的 API 地址。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('API 地址需为不含账号、密码或查询参数的 HTTP(S) 地址。');
    const protocol = resolveProtocol(profile.protocol, url.href);
    if (protocol === 'anthropic' && !key) throw new Error('Anthropic 接口需要 API Key。');
    const endpoint = buildApiEndpoint(url.href.replace(/\/+$/, ''), protocol).replace(/\/(chat\/completions|messages)$/, '/models');
    const headers = protocol === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : key ? { Authorization: `Bearer ${key}` } : {};
    const response = await request(endpoint, { method: 'GET', headers, signal });
    if (!response.ok) throw new Error(`模型列表读取失败（HTTP ${response.status}），请检查地址和密钥。`);
    const data = await response.json(), list = Array.isArray(data) ? data : data?.data;
    const models = [...new Set((Array.isArray(list) ? list : []).map(m => typeof m === 'string' ? m : m?.id).filter(m => typeof m === 'string' && m.trim()))].sort();
    if (!models.length) throw new Error('接口未返回可用模型；仍可手动填写模型名称。');
    return models;
}
