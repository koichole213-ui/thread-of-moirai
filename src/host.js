import { KEY, initialSettings, initialState, clone, restoreState, uid } from './core.js';
import { extractPreset, followReferences, rememberEntries } from './references.js';

export function chatIdentity(ctx) {
    const chat = ctx.getCurrentChatId?.() ?? ctx.chatId;
    const owner = ctx.groupId != null ? `group:${ctx.groupId}` : ctx.characters?.[ctx.characterId]?.avatar;
    return owner && chat ? JSON.stringify([owner, chat]) : null;
}
export class TavernHost {
    constructor(getContext = () => globalThis.SillyTavern.getContext()) {
        this.getContext = getContext; this.recovery = new Map(); this.credentials = new Map(); this.worldNames = [];
        const stored = this.getContext().extensionSettings?.[`${KEY}-credentials`];
        for (const [id, value] of Object.entries(stored || {})) if (typeof value === 'string') this.credentials.set(id, value);
    }
    identity() { return chatIdentity(this.getContext()); }
    settings() { return { ...initialSettings(), ...clone(this.getContext().extensionSettings[KEY] || {}) }; }
    saveSettings(settings) {
        const ctx = this.getContext(), previous = ctx.extensionSettings[KEY], previousKeys = ctx.extensionSettings[`${KEY}-credentials`];
        const ids = new Set([settings.primary, settings.secondary, ...(settings.apiPresets || [])].map(p => p?.credentialId));
        const keys = Object.fromEntries(Object.entries(previousKeys || {}).filter(([id]) => ids.has(id)));
        try { ctx.extensionSettings[KEY] = clone(settings); ctx.extensionSettings[`${KEY}-credentials`] = keys; ctx.saveSettingsDebounced(); }
        catch (error) { ctx.extensionSettings[KEY] = previous; ctx.extensionSettings[`${KEY}-credentials`] = previousKeys; throw error; }
        for (const id of this.credentials.keys()) if (!ids.has(id)) this.credentials.delete(id);
    }
    saveCredential(id, value) {
        const ctx = this.getContext(), previous = ctx.extensionSettings[`${KEY}-credentials`];
        const next = { ...previous };
        if (value) next[id] = value; else delete next[id];
        try { ctx.extensionSettings[`${KEY}-credentials`] = next; ctx.saveSettingsDebounced(); }
        catch (error) { ctx.extensionSettings[`${KEY}-credentials`] = previous; throw error; }
        if (value) this.credentials.set(id, value); else this.credentials.delete(id);
    }
    load() {
        const id = this.identity(), ctx = this.getContext();
        if (!id) return initialState();
        const metadata = ctx.chatMetadata?.[KEY], recovery = this.recovery.get(id);
        return restoreState(recovery && (!metadata || recovery.updatedAt > metadata.updatedAt) ? recovery : metadata);
    }
    async save(state, expectedIdentity, { rollbackOnFailure = false } = {}) {
        if (!expectedIdentity || this.identity() !== expectedIdentity) throw new Error('聊天已切换，未写入其他聊天。');
        state.updatedAt = Date.now(); state.saveId = uid();
        const value = clone(state), ctx = this.getContext();
        const previous = ctx.chatMetadata[KEY], previousRecovery = this.recovery.get(expectedIdentity);
        const isLatest = () => {
            if (this.recovery.get(expectedIdentity) === value) return true;
            if (rollbackOnFailure) throw new Error('保存期间聊天有新变化，请重试设置保存。');
            return false;
        };
        this.recovery.set(expectedIdentity, value);
        ctx.chatMetadata[KEY] = value;
        // The host owns persistence and serializes its chat saves. Never write a whole chat ourselves.
        try {
            // Coalesce rapid text edits; recovery is updated synchronously before this wait.
            await new Promise(resolve => setTimeout(resolve, 120));
            if (!isLatest()) return;
            if (this.identity() !== expectedIdentity) throw new Error('聊天已切换，未保存的草稿仍在本页保留。');
            await ctx.saveMetadata();
            if (!isLatest()) return;
            const stored = await this.readSavedMetadata(ctx, expectedIdentity);
            if (isLatest() && stored?.saveId !== value.saveId) throw new Error('酒馆尚未确认保存，当前草稿仍保留。');
        } catch (error) {
            if (rollbackOnFailure && this.recovery.get(expectedIdentity) === value) {
                if (ctx.chatMetadata[KEY] === value) { if (previous) ctx.chatMetadata[KEY] = previous; else delete ctx.chatMetadata[KEY]; }
                if (previousRecovery) this.recovery.set(expectedIdentity, previousRecovery); else this.recovery.delete(expectedIdentity);
            }
            throw error;
        }
    }
    async readSavedMetadata(ctx, identity) {
        const [owner, chat] = JSON.parse(identity), group = owner.startsWith('group:');
        const response = await fetch(group ? '/api/chats/group/get' : '/api/chats/get', {
            method: 'POST', headers: ctx.getRequestHeaders(), cache: 'no-store', signal: AbortSignal.timeout(15000),
            body: JSON.stringify(group ? { id: chat } : { avatar_url: owner, file_name: chat }),
        });
        if (!response.ok) throw new Error('无法确认酒馆保存结果，当前草稿仍保留。');
        const data = await response.json();
        return data?.[0]?.chat_metadata?.[KEY];
    }
    composer() { return globalThis.document.querySelector('#send_textarea'); }
    getDraft() { return this.composer()?.value || ''; }
    setDraft(value, focus = false) {
        const el = this.composer();
        if (!el) throw new Error('没有找到酒馆输入框，请先打开聊天。');
        el.value = value; el.dispatchEvent(new Event('input', { bubbles: true }));
        if (focus) el.focus();
    }
    setPrompt(text) { this.getContext().setExtensionPrompt(KEY, text, 1, 0, false, 0); }
    clearPrompt() { this.setPrompt(''); }
    async referenceHeader(settings) {
        const ctx = this.getContext(), id = this.identity();
        let worldSettings = ctx.worldInfoSettings;
        let worldModule;
        if (!worldSettings || !ctx.getWorldInfoNames) {
            try { worldModule = await import('/scripts/world-info.js'); worldSettings ||= worldModule.getWorldInfoSettings?.()?.world_info; } catch { /* Older hosts can still use the server API. */ }
        }
        const names = new Set();
        const add = list => { if (Array.isArray(list)) for (const item of list) { const name = typeof item === 'string' ? item : item?.file_id; if (typeof name === 'string' && name.trim()) names.add(name); } };
        add(ctx.getWorldInfoNames?.()); add(worldModule?.world_names);
        for (const option of globalThis.document?.querySelectorAll('#world_info_select option, #world_editor_select option') || []) {
            const name = option.textContent.trim();
            if (option.value && option.value !== 'none' && name && name !== 'None' && !name.startsWith('--')) names.add(name);
        }
        let catalogLoaded = false;
        try {
            let response = await fetch('/api/worldinfo/list', { method: 'POST', headers: ctx.getRequestHeaders?.(), signal: AbortSignal.timeout(10000) });
            if ([404, 405].includes(response.status)) response = await fetch('/api/worldinfo/list', { method: 'GET', headers: ctx.getRequestHeaders?.(), signal: AbortSignal.timeout(10000) });
            if (response.ok) {
                const data = await response.json(), list = Array.isArray(data) ? data : data?.data;
                if (Array.isArray(list)) { add(list); catalogLoaded = true; }
            }
        } catch { /* Preserve the last complete directory during a temporary failure. */ }
        if (!catalogLoaded) add(this.worldNames);
        this.worldNames = [...names];
        if (id !== this.identity()) throw new Error('聊天已切换，请重新打开设置。');
        const character = ctx.characters?.[ctx.characterId], fields = ctx.getCharacterCardFields?.() || {};
        const data = character?.data || character || {};
        const bound = [data.extensions?.world, ctx.chatMetadata?.world_info];
        const extras = worldSettings?.charLore?.find(x => x.name === character?.avatar?.replace(/\.[^.]+$/, ''))?.extraBooks || [];
        bound.push(...extras);
        const boundBooks = [...new Set(bound.filter(x => typeof x === 'string' && x))];
        followReferences(settings, boundBooks);
        const manager = ctx.getPresetManager?.('openai');
        const list = manager?.getPresetList('openai');
        const currentPreset = manager?.getSelectedPresetName?.() || '';
        const presets = Object.create(null);
        for (const [name, index] of Object.entries(list?.preset_names || {})) {
            let raw = list.presets[index];
            if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { continue; } }
            if (raw?.prompts) presets[name] = { entries: extractPreset(raw), postProcessing: raw.custom_prompt_post_processing || '', squash: raw.squash_system_messages };
        }
        if (currentPreset && ctx.chatCompletionSettings?.prompts) presets[currentPreset] = {
            entries: extractPreset(ctx.chatCompletionSettings), postProcessing: ctx.chatCompletionSettings.custom_prompt_post_processing || '', squash: ctx.chatCompletionSettings.squash_system_messages,
        };
        const substitute = text => ctx.substituteParams?.(String(text || '')) ?? String(text || '');
        return { identity: id, name: ctx.name2 || '当前角色', user: ctx.name1 || 'User', boundBooks,
            names: [...new Set([...names, ...boundBooks, ...settings.selectedBooks])], catalogWarning: !catalogLoaded && !ctx.getWorldInfoNames && !worldModule?.world_names,
            books: Object.create(null), presets, currentPreset, substitute,
            persona: ctx.powerUserSettings?.persona_description || '',
            slots: { charDescription: substitute(fields.description ?? data.description), charPersonality: substitute(fields.personality ?? data.personality), scenario: substitute(fields.scenario ?? data.scenario), dialogueExamples: substitute(fields.mesExamples ?? data.mes_example) },
            chat: (ctx.chat || []).filter(m => !m.is_system && typeof m.mes === 'string').map(m => ({ role: m.is_user ? 'user' : 'assistant', content: m.mes })),
        };
    }
    async loadBook(name, refs, settings) {
        if (Object.hasOwn(refs.books, name)) return refs.books[name];
        const ctx = this.getContext();
        let data;
        if (ctx.loadWorldInfo) data = await ctx.loadWorldInfo(name);
        else {
            const response = await fetch('/api/worldinfo/get', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ name }), signal: AbortSignal.timeout(15000) });
            if (!response.ok) throw new Error(`世界书「${name}」读取失败。`);
            data = await response.json();
        }
        if (this.identity() !== refs.identity) throw new Error('聊天已切换，旧资料未载入。');
        if (!data?.entries || typeof data.entries !== 'object') throw new Error(`世界书「${name}」读取失败。`);
        const entries = Object.entries(data.entries).map(([key, value]) => ({ ...value, uid: String(value.uid ?? key) }));
        refs.books[name] = entries; rememberEntries(settings, name, entries); return entries;
    }
    async references(settings) {
        const refs = await this.referenceHeader(settings);
        await Promise.all(settings.selectedBooks.map(name => this.loadBook(name, refs, settings)));
        return refs;
    }
    on(name, callback) {
        const ctx = this.getContext(), event = ctx.eventTypes?.[name];
        if (!event || !ctx.eventSource) return () => {};
        ctx.eventSource.on(event, callback);
        return () => ctx.eventSource.removeListener(event, callback);
    }
}
