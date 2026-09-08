import { KEY, clone, finishRound, guide, uid } from './core.js';

const supported = type => [undefined, '', 'normal', 'regenerate', 'swipe', 'continue'].includes(type);
const lastUser = chat => [...chat].reverse().find(m => m.is_user && !m.is_system);
function turnId(message) { if (!message) return null; message.extra ??= {}; return message.extra[KEY + '-turn'] ||= uid(); }

export function cleanPromptText(text, segments, keep = null) {
    let value = text;
    for (const segment of segments) {
        if (!segment || typeof value !== 'string') continue;
        const last = keep === segment ? value.lastIndexOf(segment) : -1;
        value = value.split(segment).map((part, i, all) => i < all.length - 1 && last >= 0 && all.slice(0, i + 1).join(segment).length === last ? part + segment : part).join('');
    }
    return value;
}
export class RoundBridge {
    constructor(host, state, changed, notify) {
        this.host = host; this.state = state; this.changed = changed; this.notify = notify; this.active = null;
        this.off = [host.on('GENERATION_AFTER_COMMANDS', (...args) => this.start(...args)),
            host.on('MESSAGE_SENT', () => this.sent()), host.on('MESSAGE_RECEIVED', (id, type) => this.received(id, type)),
            host.on('GENERATION_STOPPED', () => this.end()), host.on('GENERATION_ENDED', () => {
                // ST hides its stop button before emitting MESSAGE_RECEIVED for a completed stream.
                // Keep the snapshot through that same event turn; an ended UI is not proof of success.
                this.host.clearPrompt();
                const active = this.active;
                clearTimeout(this.endTimer);
                this.endTimer = setTimeout(() => { if (this.active === active) this.end(); }, 0);
            }),
            host.on('CHAT_COMPLETION_PROMPT_READY', data => this.filter(data)),
            host.on('GENERATE_AFTER_COMBINE_PROMPTS', data => this.filter(data)),
            host.on('MESSAGE_DELETED', () => { if (!this.active) { this.state().rollbackNotice = true; this.changed(); this.notify('聊天已回退，请核对当前阶段；阶段没有自动改变。'); } })];
    }
    start(type, options, dryRun) {
        if (dryRun) return;
        if (!supported(type)) { this.host.clearPrompt(); if (this.active) this.active.filterEnabled = false; return; }
        clearTimeout(this.endTimer);
        this.host.clearPrompt(); this.active = null;
        const s = this.state(), identity = this.host.identity();
        if (!identity || s.storageError) return;
        const ctx = this.host.getContext(), retry = ['regenerate', 'swipe', 'continue'].includes(type);
        let snapshot, id = retry || !this.host.getDraft().trim() ? turnId(lastUser(ctx.chat)) : null;
        const last = ctx.chat.at(-1);
        const replySnapshot = retry && last && !last.is_user && !last.is_system ? last.extra?.[KEY + '-guide'] : null;
        const old = replySnapshot || (id && s.rounds[id]);
        const temporarilyOff = s.paused || !s.enabled;
        if (temporarilyOff) snapshot = { guide: '', mode: 'attach', inputSegment: null, revision: s.revision, preference: s.preference, selected: [...s.selected], paused: s.paused };
        else if (retry && old && !s.useEditedGuide) snapshot = clone(old);
        else {
            let actual = guide(s), inputSegment = null;
            if (!retry && s.draftSegment && this.host.getDraft().includes(s.draftSegment)) {
                if (s.paused || s.mode === 'attach') this.host.setDraft(this.host.getDraft().replace(s.draftSegment, ''));
                else { inputSegment = s.draftSegment; actual = inputSegment.trim(); }
            } else if (!retry && s.draftSegment && this.host.getDraft().trim()) {
                this.notify('输入框中的引导已修改，将按输入框原文发送；本轮不额外附带。');
                actual = ''; // User edits are never deleted or silently overwritten.
            }
            snapshot = { guide: actual, inputSegment, mode: inputSegment ? 'input' : s.mode,
                revision: s.revision, preference: s.preference, selected: [...s.selected], paused: s.paused };
            if (s.mode === 'input' && !inputSegment && !retry) snapshot.guide = '';
            if (retry && s.useEditedGuide) { snapshot.mode = 'attach'; snapshot.inputSegment = null; }
        }
        this.active = { identity, snapshot, id, stopped: false, filterEnabled: true };
        if (snapshot.mode === 'attach') this.host.setPrompt(snapshot.guide);
        if (id && !(retry && temporarilyOff)) { s.rounds[id] = clone(snapshot); this.changed(); }
    }
    sent() {
        if (!this.active || this.active.identity !== this.host.identity()) return;
        const id = turnId(lastUser(this.host.getContext().chat));
        if (id) { this.active.id = id; this.state().rounds[id] = clone(this.active.snapshot); this.changed(); }
    }
    filter(data) {
        if (!this.active || !this.active.filterEnabled || data.dryRun || this.active.identity !== this.host.identity()) return;
        // ST also emits the text-combine event on the way to building OpenAI messages.
        // Its IN_CHAT prompts have not been consumed at that point.
        if (this.host.getContext().mainApi === 'openai' && !Array.isArray(data.chat)) return;
        const s = this.state(), a = this.active;
        if (a.snapshot.mode === 'attach' && a.snapshot.guide) {
            const expected = this.host.getContext().substituteParams?.(a.snapshot.guide) || a.snapshot.guide;
            const text = data.chat ? data.chat.map(m => typeof m.content === 'string' ? m.content : '').join('\n') : data.prompt;
            if (!text?.includes(expected)) return; // A raw/internal request did not consume our registered prompt.
        }
        const segments = [...new Set(Object.values(s.rounds).map(x => x.inputSegment).filter(Boolean))];
        if (s.draftSegment) segments.push(s.draftSegment);
        const keep = a.snapshot.mode === 'input' ? a.snapshot.inputSegment : null;
        if (data.chat) {
            let kept = false;
            for (const m of [...data.chat].reverse()) {
                if (typeof m.content !== 'string') continue;
                const match = !kept && keep && m.content.includes(keep);
                m.content = cleanPromptText(m.content, segments, match ? keep : null); if (match) kept = true;
            }
        } else if (typeof data.prompt === 'string') data.prompt = cleanPromptText(data.prompt, segments, keep);
        // Assembly is complete: the host's shared prompt registry must not leak into a later request.
        this.host.clearPrompt();
    }
    received(id, type) {
        const a = this.active;
        if (!a || a.identity !== this.host.identity() || !supported(type)) return;
        const ctx = this.host.getContext(), stream = ctx.streamingProcessor;
        if (stream?.isStopped || stream?.abortController?.signal?.aborted) { this.end(); return; }
        const message = ctx.chat[id];
        if (!message || message.is_user || message.is_system || !message.mes?.trim()) return;
        message.extra ??= {}; message.extra[KEY + '-guide'] = clone(a.snapshot);
        const swipe = message.swipe_info?.[message.swipe_id ?? 0];
        if (swipe) { swipe.extra ??= {}; swipe.extra[KEY + '-guide'] = clone(a.snapshot); }
        finishRound(this.state(), a.snapshot); this.state().draftSegment = null;
        this.changed(); this.end();
    }
    end() { clearTimeout(this.endTimer); this.active = null; this.host.clearPrompt(); }
    dispose() { this.end(); this.off.forEach(off => off()); }
}
