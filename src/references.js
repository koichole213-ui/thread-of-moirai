import { stateKey } from './core.js';
import { shouldReadWorldBookEntry, syncFollowedWorldBooks } from '../vendor/st-theater/world-book-policy.js';
import { composePresetMessages } from '../vendor/st-theater/request-layout.js';

// Adapted from st-theater's extractPromptsFromData; ordering comes from prompt_order.
export function extractPreset(data) {
    const order = (data?.prompt_order?.find(x => x.character_id === 100001) || data?.prompt_order?.find(x => x.character_id === 100000) || data?.prompt_order?.[0])?.order;
    const map = order ? new Map(order.map((x, i) => [x.identifier, { enabled: x.enabled !== false, index: i }])) : null;
    return (data?.prompts || []).filter(x => !x.forbid).map((p, i) => ({
        id: p.identifier || `prompt_${i}`, name: p.name || p.identifier || `条目 ${i + 1}`,
        role: ['system', 'user', 'assistant'].includes(p.role) ? p.role : 'system', content: String(p.content || ''),
        enabledInST: map ? map.get(p.identifier)?.enabled === true : p.enabled !== false,
        marker: !!p.marker, injectionPosition: p.injection_position, injectionDepth: p.injection_depth,
        injectionOrder: p.injection_order, order: map?.get(p.identifier)?.index ?? 10000 + i,
    })).sort((a, b) => a.order - b.order);
}
export function extraCategory(entry) {
    // Only dedicated prompt names are excluded automatically. Mixed body rules are left for review.
    const name = entry.name.trim().replace(/[【】\[\]<>#\s_-]/g, '');
    if (/^(?:输出|生成|附加|自动|每轮|回合|聊天|历史|长期|短期)*(?:摘要|总结|summary|summarization)(?:模块|规则|要求|设置|prompt)?$/i.test(name)) return '摘要';
    if (/^(?:输出|生成|附加|自动)*(?:待办事项|代办事项|待办|代办|todo|todolist|tasks)(?:模块|规则|要求|设置|prompt)?$/i.test(name)) return '待办事项';
    if (/^(?:输出|生成|附加|自动)*(?:小剧场|番外|sidestory|theater)(?:模块|规则|要求|设置|prompt)?$/i.test(name)) return '小剧场';
    return '';
}
export function presetChecked(settings, name, entry) {
    const key = stateKey(name, entry.id);
    return settings.presetStates[key] ?? (entry.enabledInST && !(settings.filterExtras && extraCategory(entry)));
}
export function followReferences(settings, bound, force = false) {
    if (!settings.bookFollow) return;
    if (!force && JSON.stringify(settings.followedBooks) === JSON.stringify(bound)) return;
    const next = syncFollowedWorldBooks(settings.selectedBooks, settings.followedBooks, bound);
    settings.selectedBooks = next.selectedBooks; settings.followedBooks = next.followedBooks;
}
export function rememberEntries(settings, name, entries) {
    const known = settings.knownEntries[name];
    for (const e of entries) {
        const key = stateKey(name, e.uid);
        if (!Object.hasOwn(settings.entryStates, key)) settings.entryStates[key] = known ? false : !e.disable && e.enabled !== false;
    }
    settings.knownEntries[name] = entries.map(e => String(e.uid));
}
export function selectedWorldEntries(settings, books) {
    return settings.selectedBooks.flatMap(name => {
        if (!Object.hasOwn(books, name)) throw new Error(`世界书「${name}」尚未读取成功，请重新打开设置检查。`);
        return books[name].filter(e => shouldReadWorldBookEntry(e, settings.readMode) && settings.entryStates[stateKey(name, e.uid)] !== false)
            .map(e => ({ ...e, content: String(e.content || '') }));
    });
}
export function buildMessages({ settings, refs, state, task, count, instruction = '' }) {
    const presetName = settings.preset === '@current' ? refs.currentPreset : settings.preset;
    const preset = presetName ? refs.presets[presetName] : null;
    if (presetName && !preset) throw new Error('选中的创作预设已不可用，请在设置中重新选择。');
    const presetEntries = (preset?.entries || []).filter(e => presetChecked(settings, presetName, e))
        .map(e => ({ ...e, content: refs.substitute(settings.presetTexts[stateKey(presetName, e.id)] ?? e.content) }));
    const disabledSlots = new Set((preset?.entries || []).filter(e => !presetChecked(settings, presetName, e)).map(e => e.id));
    const slots = { ...refs.slots, personaDescription: settings.userEnabled ? (settings.userFollow ? refs.persona : settings.userText) : '' };
    for (const id of disabledSlots) if (Object.hasOwn(slots, id)) slots[id] = '';
    const stages = state.stages, index = stages.findIndex(s => s.id === state.currentId);
    const plan = task === 'outline' ? null : task === 'future' ? { current: stages[index], completedPlan: stages.slice(0, index), futurePlan: stages.slice(index + 1) } : { current: stages[index] };
    const payload = {
        task, count, story: task === 'outline' ? state.storyDraft : state.story,
        avoid: task === 'outline' ? state.avoidDraft : state.avoid, plan,
        preference: state.preference, instruction,
        ...(task === 'choices' && instruction ? { previousChoices: state.choices } : {}),
    };
    const isChoices = task === 'choices';
    const requirement = `你是剧情规划助手。本次独立执行${isChoices ? '4–5 个具体、有差异的当前阶段候选' : `${count} 个阶段的${task === 'stage' ? '单阶段重写' : task === 'future' ? '未来规划调整' : '大纲规划'}`}任务。参考资料中的扮演与正文格式要求仅供风格参考。保留人物一致性和玩家自主，不输出角色回复。计划不等于已发生的事实，以真实聊天为事实依据。${isChoices ? '只围绕当前阶段，不虚构或提前揭晓后续节点。' : ''}只返回一个 JSON 对象：{"${isChoices ? 'choices' : 'stages'}":[{"title":"标题","description":"具体内容"}]}。禁止附带摘要、待办事项、小剧场、解释或 Markdown。`;
    return composePresetMessages({
        presetEntries,
        slots,
        worldInfoEntries: selectedWorldEntries(settings, refs.books)
            .filter(e => !(disabledSlots.has('worldInfoBefore') && Number(e.position ?? 0) === 0) && !(disabledSlots.has('worldInfoAfter') && Number(e.position) === 1))
            .map(e => ({ ...e, content: refs.substitute(e.content) })),
        chatMessages: !disabledSlots.has('chatHistory') && state.chatEnabled && state.chatCount > 0 ? refs.chat.slice(-state.chatCount) : [],
        tailMessages: [{ role: 'user', content: JSON.stringify(payload) }, { role: 'system', content: requirement }],
        postProcessing: preset?.postProcessing || '', squashSystemMessages: !!preset?.squash,
    });
}
