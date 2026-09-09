import { initialState } from './src/core.js';
import { TavernHost } from './src/host.js';
import { Generator } from './src/generation.js';
import { RoundBridge } from './src/rounds.js';
import { mountUI } from './src/ui.js';
import { mountAccess } from './src/access.js';

export async function startPlot(host = new TavernHost(), transports) {
    let state = host.load(), settings = host.settings(), identity = host.identity();
    const generator = new Generator(host, transports);
    const persist = (candidate = state, rollbackOnFailure = false) => identity ? host.save(candidate, identity, { rollbackOnFailure }) : Promise.reject(new Error('当前聊天不可保存。'));
    const ui = await mountUI(host, generator, () => state, () => settings, value => { settings = value; }, persist, new URL('./', import.meta.url));
    const changed = () => { ui.render(); void persist().catch(() => ui.toast('酒馆保存失败，当前草稿仍保留，请重试。')); };
    const rounds = new RoundBridge(host, () => state, changed, ui.toast);
    const loadChat = () => {
        generator.cancel(); rounds.end();
        const owned = state.draftSegment;
        if (owned && host.getDraft().includes(owned)) host.setDraft(host.getDraft().replace(owned, ''));
        identity = host.identity();
        try { state = host.load(); } catch { identity = null; state = { ...initialState(), enabled: false, storageError: true }; ui.toast('此聊天保存的大纲无法读取，已停止写入与引导；原数据保留。'); }
        ui.reset();
    };
    const off = [host.on('CHAT_CHANGED', loadChat), host.on('CHAT_LOADED', loadChat)];
    for (const event of ['PERSONA_CHANGED', 'CHARACTER_EDITED', 'WORLDINFO_UPDATED', 'WORLDINFO_SETTINGS_UPDATED', 'OAI_PRESET_CHANGED_AFTER']) {
        off.push(host.on(event, () => { generator.cancel(); ui.reset(); }));
    }
    const access = mountAccess(host, ui);
    return { open: ui.open, dispose() { generator.cancel(); rounds.dispose(); off.forEach(fn => fn()); access.dispose(); ui.dispose(); host.credentials.clear(); } };
}

if (globalThis.SillyTavern?.getContext && !globalThis.__ST_PLOT_TEST__) {
    globalThis.stPlot?.dispose?.();
    startPlot().then(app => { globalThis.stPlot = app; }).catch(() => globalThis.toastr?.error('天方匣未能载入。请检查扩展文件是否完整，原聊天未修改。'));
}
