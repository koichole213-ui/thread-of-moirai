export const VERSION = '0.1.1-preview.3';
export const KEY = 'st-plot';
export const clone = value => structuredClone(value);
// IDs are data identifiers, not secrets. LAN HTTP may not expose randomUUID.
let idSequence = 0;
export const uid = () => globalThis.crypto?.randomUUID?.() ?? `plot-${Date.now().toString(36)}-${(++idSequence).toString(36)}-${Math.random().toString(36).slice(2)}`;
export const stateKey = (name, id) => JSON.stringify([String(name), String(id)]);

export function initialState() {
    return { version: 1, updatedAt: 0, revision: 0, stages: [], currentId: null,
        story: '', avoid: '', storyDraft: '', avoidDraft: '', stageCount: 12,
        choices: [], selected: [], preference: '', paused: false, mode: 'input',
        display: 'all', origin: 'continue', chatEnabled: true, chatCount: 20,
        enabled: true, useEditedGuide: false, rollbackNotice: false, rounds: {}, draftSegment: null };
}
export function initialSettings() {
    const profile = { name: '我的连接', protocol: 'openai', model: '', stream: true, endpoint: '', credentialId: uid() };
    return { version: 1, userEnabled: true, userFollow: true, userText: '', bookFollow: true,
        selectedBooks: [], followedBooks: [], entryStates: {}, knownEntries: {}, readMode: 'all',
        route: 'main', primary: clone(profile), secondary: { ...profile, credentialId: uid() },
        secondaryEnabled: false, apiPresets: [profile], preset: '@current', presetStates: {}, presetTexts: {},
        filterExtras: true };
}
export function restoreState(raw) {
    if (!raw) return initialState();
    if (raw.version !== 1) throw new Error('大纲存储版本无法读取，原数据仍保留。');
    const s = { ...initialState(), ...clone(raw) };
    if (!Array.isArray(s.stages) || s.stages.some(x => !x || typeof x.id !== 'string' || typeof x.title !== 'string' || typeof x.description !== 'string')) throw new Error('保存的大纲格式无法读取，原数据仍保留。');
    if (new Set(s.stages.map(x => x.id)).size !== s.stages.length) throw new Error('大纲阶段标识重复，原数据仍保留。');
    if (!s.stages.some(x => x.id === s.currentId)) s.currentId = s.stages[0]?.id ?? null;
    s.choices = Array.isArray(s.choices) ? s.choices.filter(x => x && typeof x.id === 'string' && typeof x.title === 'string' && typeof x.description === 'string') : [];
    s.selected = [...new Set(Array.isArray(s.selected) ? s.selected : [])].filter(id => s.choices.some(x => x.id === id)).slice(0, 2);
    s.rounds = s.rounds && typeof s.rounds === 'object' && !Array.isArray(s.rounds) ? s.rounds : {};
    return s;
}
export const currentStage = s => s.stages.find(x => x.id === s.currentId);
export const currentIndex = s => s.stages.findIndex(x => x.id === s.currentId);
export function stageCount(value) {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 1) throw new Error('阶段数量请填写大于 0 的整数。');
    return n;
}
const nonempty = (value, label) => {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`生成结果缺少${label}，原内容未改变。`);
    return value.trim();
};
export function parseResult(text, type, count) {
    // Accept one fenced JSON object; never salvage a partial/truncated response.
    let data;
    try { data = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
    catch { throw new Error('返回内容不是完整的结构化结果。请重试或调整创作预设，原内容未改变。'); }
    const field = type === 'choices' ? 'choices' : 'stages';
    if (!data || !Array.isArray(data[field])) throw new Error('返回结构不完整，原内容未改变。');
    const items = data[field];
    if ((field === 'stages' && items.length !== count) || (field === 'choices' && (items.length < 4 || items.length > 5))) throw new Error(field === 'stages' ? `需要 ${count} 个阶段，实际收到 ${items.length} 个。原大纲未改变。` : '候选需有 4–5 项，原候选未改变。');
    const result = items.map(x => ({ id: uid(), title: nonempty(x?.title, '标题'), description: nonempty(x?.description, '内容') }));
    if (new Set(result.map(x => x.title)).size !== result.length) throw new Error('生成了重复标题，请重试。');
    // Extraneous summary/todo/theater fields are deliberately not adopted.
    return result;
}
export function selectChoice(s, id, checked) {
    if (!s.choices.some(x => x.id === id)) return;
    if (checked && !s.selected.includes(id)) {
        if (s.selected.length >= 2) throw new Error('最多选两个方向，先取消一个就能换选。');
        s.selected.push(id);
    } else if (!checked) s.selected = s.selected.filter(x => x !== id);
}
export function invalidateChoices(s) { s.choices = []; s.selected = []; s.revision++; }
export function moveStage(s, id) {
    if (!s.stages.some(x => x.id === id) || id === s.currentId) return false;
    s.currentId = id; invalidateChoices(s); return true;
}
export function adoptStages(s, items, kind = 'outline') {
    if (kind === 'stage') {
        const i = currentIndex(s); s.stages[i] = { ...items[0], id: s.currentId };
    } else if (kind === 'future') s.stages.splice(currentIndex(s) + 1, Infinity, ...items);
    else { s.stages = items; s.currentId = items[0]?.id ?? null; s.story = s.storyDraft; s.avoid = s.avoidDraft; }
    invalidateChoices(s);
}
export function removeStage(s, id) {
    const i = s.stages.findIndex(x => x.id === id);
    if (i < 0) return;
    s.stages.splice(i, 1);
    if (s.currentId === id) s.currentId = s.stages[Math.min(i, s.stages.length - 1)]?.id ?? null;
    invalidateChoices(s);
}
export function reorderStage(s, id, direction) {
    const i = s.stages.findIndex(x => x.id === id), j = i + direction;
    if (i < 0 || j < 0 || j >= s.stages.length) return;
    [s.stages[i], s.stages[j]] = [s.stages[j], s.stages[i]];
    s.revision++;
}
export function guide(s) {
    const stage = currentStage(s);
    if (!s.enabled || s.paused || !stage) return '';
    const lines = ['【本轮剧情引导】', `大方向：${s.story}`, `当前阶段：${currentIndex(s) + 1} / ${s.stages.length} · ${stage.title}`, stage.description];
    s.selected.forEach((id, i) => { const c = s.choices.find(x => x.id === id); if (c) lines.push(`本轮方向${i + 1}：${c.title}——${c.description}`); });
    if (s.selected.length > 1) lines.push('把两个方向自然衔接，尊重实际聊天；如冲突优先第一个，不强行同时执行。');
    if (s.preference.trim()) lines.push(`补充偏好：${s.preference.trim()}`);
    if (s.avoid.trim()) lines.push(`避免：${s.avoid.trim()}`);
    lines.push('停留在当前阶段，不提前执行后续大纲；计划与未选择的候选都不是已发生的事实。不替玩家决定对白、内心或关键行动。', '【引导结束】');
    return lines.join('\n');
}
export function visibleStageName(s, i) { return s.display === 'current' && i > currentIndex(s) ? '尚未揭晓' : s.stages[i].title; }

// Ownership is an exact remembered segment, not a broad regex over user prose.
export function replaceOwnedDraft(text, owned, replacement) {
    let base = text;
    if (owned && text.includes(owned)) base = text.replace(owned, '');
    else if (owned) throw new Error('输入框中的旧引导已被你修改。请先自行移除或整理这一段，再加入新引导；原文没有改变。');
    const segment = replacement ? `${base && !base.endsWith('\n\n') ? '\n\n' : ''}${replacement}` : '';
    return { text: base + segment, owned: segment || null };
}
export function finishRound(s, snapshot) {
    if (snapshot && snapshot.revision === s.revision && snapshot.preference === s.preference && JSON.stringify(snapshot.selected) === JSON.stringify(s.selected) && snapshot.paused === s.paused) {
        s.selected = []; s.preference = ''; s.paused = false;
    }
    s.useEditedGuide = false;
}
export class RequestGate {
    constructor() { this.serial = 0; this.controller = null; }
    cancel() { this.serial++; this.controller?.abort(); this.controller = null; }
    start(identity, revision) { this.cancel(); this.controller = new AbortController(); return { serial: this.serial, identity, revision, signal: this.controller.signal }; }
    valid(token, identity, revision) { return token.serial === this.serial && !token.signal.aborted && token.identity === identity && token.revision === revision; }
}
