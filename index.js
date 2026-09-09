import { initialState } from './src/core.js';
import { TavernHost } from './src/host.js';
import { Generator } from './src/generation.js';
import { RoundBridge } from './src/rounds.js';
import { mountUI } from './src/ui.js';
import { mountAccess } from './src/access.js';

async function startRuntime(host, transports) {
    let state, settings = host.settings(), identity = host.identity();
    try { state = host.load(); } catch { identity = null; state = { ...initialState(), enabled: false, storageError: true }; }
    const generator = new Generator(host, transports);
    const persist = (candidate = state, rollbackOnFailure = false) => identity ? host.save(candidate, identity, { rollbackOnFailure }) : Promise.reject(new Error('当前聊天不可保存。'));
    const ui = await mountUI(host, generator, () => state, () => settings, value => { settings = value; }, persist, new URL('./', import.meta.url));
    const cleanup = [() => ui.dispose()];
    try {
    const changed = () => { ui.render(); void persist().catch(() => ui.toast('酒馆保存失败，当前草稿仍保留，请重试。')); };
    const rounds = new RoundBridge(host, () => state, changed, ui.toast);
    cleanup.push(() => rounds.dispose());
    const loadChat = () => {
        generator.cancel(); rounds.end();
        const owned = state.draftSegment;
        if (owned && host.getDraft().includes(owned)) host.setDraft(host.getDraft().replace(owned, ''));
        identity = host.identity();
        try { state = host.load(); } catch { identity = null; state = { ...initialState(), enabled: false, storageError: true }; ui.toast('此聊天保存的大纲无法读取，已停止写入与引导；原数据保留。'); }
        ui.reset();
    };
    const off = []; cleanup.push(() => off.forEach(fn => fn()));
    off.push(host.on('CHAT_CHANGED', loadChat)); off.push(host.on('CHAT_LOADED', loadChat));
    for (const event of ['PERSONA_CHANGED', 'CHARACTER_EDITED', 'WORLDINFO_UPDATED', 'WORLDINFO_SETTINGS_UPDATED', 'OAI_PRESET_CHANGED_AFTER']) {
        off.push(host.on(event, () => { generator.cancel(); ui.reset(); }));
    }
    return { ...ui, dispose() { generator.cancel(); rounds.dispose(); off.forEach(fn => fn()); ui.dispose(); } };
    } catch (error) { generator.cancel(); for (const dispose of cleanup.reverse()) { try { dispose(); } catch {} } throw error; }
}

// Register launchers before attempting the larger interface. A failed load is retryable.
export async function startPlot(host = new TavernHost(), transports) {
    let runtime, loading, disposed = false, accessValue, accessListener;
    const status = document.createElement('p'); status.id = 'st-plot-load-status'; status.setAttribute('role', 'status');
    const notify = text => {
        status.textContent = text;
        const target = document.querySelector('#st-plot-access-content') || document.body;
        if (status.parentNode !== target) target.append(status);
        globalThis.toastr?.error(text);
    };
    async function load() {
        if (runtime || disposed) return runtime;
        if (loading) return loading;
        loading = (async () => {
            try {
                const app = await startRuntime(host, transports);
                if (disposed) { app.dispose(); return; }
                runtime = app; runtime.setAccess(accessValue); runtime.onAccessChange(accessListener); status.remove(); return runtime;
            } catch {
                document.getElementById('st-plot-root')?.remove();
                notify('摩伊之线界面未能载入，点击打开可重试。请确认扩展已完整更新并刷新酒馆。');
            } finally { loading = null; }
        })();
        return loading;
    }
    const proxy = {
        open: tab => { if (disposed) return; if (runtime) return runtime.open(tab); return load().then(app => { if (!disposed) app?.open(tab); }); },
        toast: text => runtime ? runtime.toast(text) : notify(text),
        setAccess: value => { accessValue = value; runtime?.setAccess(value); },
        onAccessChange: fn => { accessListener = fn; runtime?.onAccessChange(fn); },
    };
    const access = mountAccess(host, proxy);
    await load();
    return { open: proxy.open, dispose() { disposed = true; access.dispose(); runtime?.dispose(); status.remove(); host.credentials.clear(); } };
}

if (!globalThis.__ST_PLOT_TEST__ && typeof document !== 'undefined') {
    const start = () => {
        if (!globalThis.SillyTavern?.getContext || !document.body) return false;
        const ctx = globalThis.SillyTavern.getContext();
        if (!ctx.extensionSettings || !ctx.eventSource) return false;
        globalThis.stPlot?.dispose?.();
        startPlot().then(app => { globalThis.stPlot = app; }).catch(() => globalThis.toastr?.error('摩伊之线入口未能载入，请刷新酒馆后重试。'));
        return true;
    };
    const ready = () => { if (!start()) { const timer = setInterval(() => { if (start()) clearInterval(timer); }, 500); } };
    if (globalThis.jQuery) globalThis.jQuery(ready);
    else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true });
    else ready();
}
