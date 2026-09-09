import { VERSION, clone, uid, guide, currentStage, currentIndex, stageCount, moveStage, invalidateChoices,
    selectChoice, adoptStages, removeStage, reorderStage, visibleStageName, replaceOwnedDraft } from './core.js';
import { mountSettings } from './settings-ui.js';
import { mountTabs } from './tabs.js';
import { mountDock } from './dock.js';

export async function mountUI(host, generator, getState, getSettings, setSettings, persist, baseURL) {
    const existing = document.getElementById('st-plot-root'); existing?.remove();
    const rootNode = document.createElement('div'); rootNode.id = 'st-plot-root';
    const root = rootNode.attachShadow({ mode: 'open' });
    const responses = await Promise.all(['ui/shell.html', 'ui/interface.css'].map(path => fetch(new URL(path, baseURL), { cache: 'no-store' })));
    if (responses.some(r => !r.ok)) throw new Error('界面文件读取失败。');
    const [html, css] = await Promise.all(responses.map(r => r.text()));
    const style = document.createElement('style'); style.textContent = css;
    const surface = document.createElement('div'); surface.className = 'plot-surface'; surface.innerHTML = html;
    root.append(style, surface); document.body.append(rootNode);
    const failedCleanup = [() => rootNode.remove()];
    try {
    for (const id of ['main-overlay','dock-stage-page','dock-options-page','dock-page-heading','dock-open-outline','close-main']) if (!root.querySelector(`#${id}`)) throw new Error('界面文件版本不一致，请完整更新。');
    const $ = s => root.querySelector(s), $$ = s => [...root.querySelectorAll(s)];
    const element = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
    let toastTimer, dockOpen = false, dockPage = 'stage', pending = null, busy = false, requestSerial = 0, disposed = false, editorId = null;
    let access = { visible: true, tuck: true, side: 'right', position: .4 }, accessChange = null, dock;
    const toast = text => {
        const message = $('#toast');
        // Native modals are above ordinary page layers: keep feedback inside the active modal.
        ($$('dialog[open]').at(-1) || surface).append(message);
        message.textContent = text; message.classList.add('show'); clearTimeout(toastTimer);
        toastTimer = setTimeout(() => message.classList.remove('show'), 4500);
    };
    const changed = (redraw = true) => { void persist().catch(() => toast('酒馆保存失败，当前草稿仍保留，请重试。')); if (redraw) render(); };
    const tabs = mountTabs(root); failedCleanup.push(() => tabs.dispose());
    let previousOverflow = null;
    const syncScrollLock = () => {
        const lock = !$('#main-overlay').hidden || !!$('dialog[open]');
        if (lock && previousOverflow === null) { previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; }
        if (!lock && previousOverflow !== null) { document.body.style.overflow = previousOverflow; previousOverflow = null; }
    };
    const scrollObserver = new MutationObserver(syncScrollLock); scrollObserver.observe(root, { subtree: true, attributes: true, attributeFilter: ['open', 'hidden'] });
    failedCleanup.push(() => { scrollObserver.disconnect(); if (previousOverflow !== null) document.body.style.overflow = previousOverflow; clearTimeout(toastTimer); });
    function openDialog(id) { const dialog = $(id); if (!dialog.open) dialog.showModal(); }
    function closeDock() { dockOpen = false; $('#dock-panel').hidden = true; for (const id of ['dock-toggle', 'dock-options']) $(`#${id}`).setAttribute('aria-expanded', 'false'); dock?.sync(access); }
    function openMain(tab = 0) {
        const main = $('#main-overlay');
        closeDock(); main.hidden = false; if (!main.open) main.showModal();
        tabs.switchTab(tab); tabs.draw(); $('#close-main').focus();
    }
    function closeMain() { const main = $('#main-overlay'); if (main.open) main.close(); main.hidden = true; }
    $('#main-overlay').addEventListener('close', () => {
        if ($('#main-overlay').open) return;
        $('#main-overlay').hidden = true; if (!disposed) dock?.sync(access);
    });
    function showDock(trigger) {
        const page = trigger === 'dock-options' ? 'options' : 'stage';
        dockOpen = !dockOpen || dockPage !== page; dockPage = page;
        $('#dock-panel').hidden = !dockOpen; $('#dock-panel').dataset.opening = String(dockOpen);
        $('#dock-stage-page').hidden = page !== 'stage'; $('#dock-options-page').hidden = page !== 'options';
        $('#dock-page-heading').textContent = page === 'stage' ? '当前阶段' : '剧情选项';
        for (const id of ['dock-toggle', 'dock-options']) $(`#${id}`).setAttribute('aria-expanded', String(dockOpen && id === trigger));
        dock?.sync(access);
        if (dockOpen) (trigger === 'dock-options' ? $('#dock-choices input') || $('#dock-close') : $('#dock-close')).focus();
    }
    dock = mountDock(root, { isOpen: () => dockOpen || !!$('dialog[open]'), save: patch => accessChange?.(patch) });
    failedCleanup.push(() => dock.dispose());
    $('#dock-open-outline').onclick = () => { closeDock(); openMain(1); pending = null; showOutline(); };
    $('#close-main').onclick = closeMain;
    $('#main-overlay').onclick = e => { if (e.target === $('#main-overlay')) closeMain(); };
    for (const id of ['dock-toggle', 'dock-options']) $(`#${id}`).onclick = () => showDock(id);
    $('#dock-close').onclick = () => { closeDock(); $('#dock-toggle').focus(); };
    $$('.close-dialog').forEach(b => b.onclick = () => b.closest('dialog').close());
    $$('dialog').forEach(d => d.addEventListener('click', e => {
        if (e.target !== d) return; const r = d.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
    }));
    const globalKeys = e => { if (e.key === 'Escape' && !$('dialog[open]')) { if (dockOpen) closeDock(); else closeMain(); } };
    const outside = e => { if (dockOpen && !e.composedPath().includes(rootNode)) closeDock(); };
    document.addEventListener('keydown', globalKeys); document.addEventListener('pointerdown', outside);
    failedCleanup.push(() => { document.removeEventListener('keydown', globalKeys); document.removeEventListener('pointerdown', outside); });
    function cancel() { requestSerial++; generator.cancel(); busy = false; $('#request-dialog').close(); render(); }
    function invalidate() {
        cancel(); pending = null;
        const s = getState();
        if (s.draftSegment) {
            const text = host.getDraft();
            if (text.includes(s.draftSegment)) { host.setDraft(text.replace(s.draftSegment, '')); s.draftSegment = null; toast('阶段或配置已调整，已移除输入框中未修改的旧引导，保留你的原文。'); }
            else toast('输入框的旧引导已修改，请在发送前核对；原文没有改变。');
        }
    }
    const settingsUI = mountSettings(root, { host, getState, getSettings, toast,
        saveConnections: patch => {
            const next = { ...getSettings(), ...clone(patch) }; host.saveSettings(next); setSettings(next); generator.cancel();
        },
        commit: async (settings, chat) => {
            const live = getState(), identity = host.identity(), candidate = { ...clone(live), ...chat, revision: live.revision + 1 };
            if (candidate.draftSegment && host.getDraft().includes(candidate.draftSegment)) candidate.draftSegment = null;
            await persist(candidate, true);
            if (live !== getState() || identity !== host.identity()) throw new Error('聊天已切换，设置没有应用到新聊天。');
            host.saveSettings(settings); setSettings(settings); invalidate(); Object.assign(live, chat, { revision: candidate.revision, draftSegment: candidate.draftSegment }); render();
        } });
    async function generate(task, revised = false, instruction = '') {
        const s = getState();
        if (busy) return;
        if (task !== 'outline' && !currentStage(s)) { toast('先生成或新增一个阶段。'); openMain(1); return; }
        let count;
        try { count = task === 'outline' ? stageCount(s.stageCount) : task === 'stage' ? 1 : task === 'future' ? s.stages.length - currentIndex(s) - 1 : 5; }
        catch (e) { toast(e.message); return; }
        if (count === 0) { toast('当前已经是最后一个阶段，没有待调整的后续。'); return; }
        if (task === 'future' && !s.chatEnabled) { toast('请先在参考设置中开启聊天前文，再按实际聊天调整。'); return; }
        const serial = ++requestSerial; busy = true; render();
        $('#request-status').textContent = '正在读取所选参考资料…'; openDialog('#request-dialog');
        let chars = 0;
        try {
            const result = await generator.generate({ state: s, settings: getSettings(), task, count, instruction, revised,
                onChunk: text => { chars = text.length; $('#request-status').textContent = `正在创作 · 已收到 ${chars} 字，完整结果会在校验后显示`; } });
            if (disposed || serial !== requestSerial) return;
            busy = false; $('#request-dialog').close();
            if (task === 'choices') { s.choices = result.items; s.selected = []; changed(); toast('候选已生成，选中后由你决定何时输入。'); }
            else { pending = { ...result, kind: task, identity: host.identity(), revision: s.revision }; showOutline(); }
        } catch (e) {
            if (serial === requestSerial) { busy = false; $('#request-dialog').close(); if (e.name !== 'AbortError') toast(e.message?.startsWith('THEATER') ? '生成失败，请检查连接或调整预设后重试。原内容仍保留。' : safeError(e)); }
        } finally { if (!disposed && serial === requestSerial) { busy = false; render(); } }
    }
    function safeError(e) {
        // Transport errors can include server-provided text. Only our own actionable messages are shown.
        const allowed = ['请', '此版本', '返回', '需要', '候选', '生成结果', '生成了', '选中的', '世界书', '阶段数量', 'API 地址'];
        return allowed.some(s => e.message?.startsWith(s)) ? e.message : '生成失败或连接中断。请检查连接与预设后重试，原内容仍保留。';
    }
    $('#cancel-generation').onclick = cancel; $('#cancel-request').onclick = cancel;
    $('#request-dialog').addEventListener('close', () => { if (busy && !$('#request-dialog').open) cancel(); });
    for (const id of ['reroll', 'dock-reroll']) $(`#${id}`).onclick = () => generate('choices', getState().choices.length > 0, getState().choices.length ? '换一批新的具体方向，避免重复上一批。' : '');
    $('#modify-choices').onclick = () => generate('choices', true, `按本轮补充偏好修改这些选项：${getState().preference || '保留主题，改善具体性与差异。'}`);
    $('#preview-outline').onclick = () => generate('outline');
    $('#adjust-future').onclick = () => generate('future');
    $('#rewrite-stage').onclick = () => { $('#edit-dialog').close(); generate('stage', false, `参考本次修改意图：${$('#edit-name').value}\n${$('#edit-description').value}`); };
    $('#saved-outline').onclick = () => { pending = null; showOutline(); };
    function showOutline() {
        const s = getState(), data = pending?.items || s.stages;
        $('#outline-preview').replaceChildren(); $('#adopt-outline').hidden = !pending;
        $('#add-stage').hidden = !!pending; $('#adjust-future').hidden = !!pending;
        $('#outline-dialog-title').textContent = pending ? `${data.length} 个阶段 · 待采用` : '正在使用的大纲';
        data.forEach((item, i) => {
            const entry = element('div', null, 'outline-entry');
            const hidden = s.display === 'current' && (pending ? pending.kind === 'future' || (pending.kind === 'outline' && i > 0) : i > currentIndex(s));
            entry.append(element('h3', `${i + 1}  ${hidden ? '尚未揭晓' : item.title}`));
            if (!hidden && s.display !== 'summary') entry.append(element('p', item.description));
            if (!pending) {
                const actions = element('div', null, 'outline-tools');
                for (const [label, action, disabled] of [
                    ['跳到此阶段', () => { go(item.id); $('#outline-dialog').close(); }, false],
                    ['编辑', () => edit(item.id), hidden],
                    ['上移', () => { invalidate(); reorderStage(s, item.id, -1); changed(); showOutline(); }, i === 0],
                    ['下移', () => { invalidate(); reorderStage(s, item.id, 1); changed(); showOutline(); }, i === data.length - 1],
                    ['删除', () => { invalidate(); removeStage(s, item.id); changed(); showOutline(); }, false],
                ]) { const b = element('button', label, 'text-button'); b.disabled = disabled; b.onclick = action; actions.append(b); }
                entry.append(actions);
            }
            $('#outline-preview').append(entry);
        });
        if (!data.length) $('#outline-preview').append(element('p', '还没有大纲，可以生成，也可以手动新增阶段。', 'helper'));
        openDialog('#outline-dialog');
    }
    $('#adopt-outline').onclick = () => {
        const s = getState(), candidate = pending;
        if (!candidate || candidate.identity !== host.identity() || candidate.revision !== s.revision) { toast('聊天或大纲已改变，请重新生成。'); return; }
        invalidate(); adoptStages(s, candidate.items, candidate.kind); changed(); $('#outline-dialog').close(); openMain(0); toast('已采用，当前阶段仍由你手动推进。');
    };
    function edit(id) {
        editorId = id; const stage = getState().stages.find(x => x.id === id);
        $('#edit-name').value = stage?.title || ''; $('#edit-description').value = stage?.description || '';
        $('#rewrite-stage').hidden = !id || id !== getState().currentId;
        openDialog('#edit-dialog');
    }
    $('#edit-stage').onclick = () => edit(getState().currentId); $('#add-stage').onclick = () => edit(null);
    $('#edit-form').onsubmit = e => {
        e.preventDefault(); const title = $('#edit-name').value.trim(), description = $('#edit-description').value.trim();
        if (!title || !description) return;
        invalidate(); const s = getState();
        if (editorId) { const item = s.stages.find(x => x.id === editorId); if (!item) return; Object.assign(item, { title, description }); }
        else { const item = { id: uid(), title, description }; s.stages.push(item); s.currentId ||= item.id; }
        invalidateChoices(s); changed(); $('#edit-dialog').close(); if ($('#outline-dialog').open) showOutline();
    };
    function go(id) { if (!id || id === getState().currentId) return; invalidate(); moveStage(getState(), id); changed(); }
    for (const [id, delta] of [['prev-stage', -1], ['next-stage', 1], ['dock-prev', -1], ['dock-next', 1]]) $(`#${id}`).onclick = () => go(getState().stages[currentIndex(getState()) + delta]?.id);
    function renderStageList() {
        const s = getState(), query = $('#stage-search').value.trim().toLowerCase(); $('#stage-list').replaceChildren();
        s.stages.forEach((item, i) => {
            const title = visibleStageName(s, i); if (!`${i + 1} ${title}`.toLowerCase().includes(query)) return;
            const b = element('button', `${i + 1}  ${title}`, 'stage-item'); b.setAttribute('aria-current', String(item.id === s.currentId));
            b.onclick = () => { go(item.id); $('#stage-dialog').close(); }; $('#stage-list').append(b);
        });
    }
    for (const id of ['stage-picker', 'dock-stage-picker']) $(`#${id}`).onclick = () => { $('#stage-search').value = ''; renderStageList(); openDialog('#stage-dialog'); };
    $('#stage-search').oninput = renderStageList;
    function insert(dock) {
        const s = getState(); if (s.paused || !s.enabled || !currentStage(s) || (dock && !s.selected.length)) return;
        if (!dock && s.mode === 'attach') { toast('发送时会附带当前引导，输入框保持原文。'); return; }
        try {
            const next = replaceOwnedDraft(host.getDraft(), s.draftSegment, guide(s));
            host.setDraft(next.text); s.draftSegment = next.owned; if (dock) s.mode = 'input'; changed(); closeDock(); closeMain(); host.composer()?.focus(); toast('已放进酒馆输入框，原文保留，尚未发送。');
        } catch (e) { toast(e.message); }
    }
    $('#apply-choice').onclick = () => insert(false); $('#dock-insert').onclick = () => insert(true);
    $('#view-guide').onclick = () => { $('#guide-text').textContent = guide(getState()) || '本轮不会附带剧情引导。'; openDialog('#guide-dialog'); };
    $('#pause').onclick = () => { const s = getState(); s.paused = !s.paused; if (s.paused) invalidate(); changed(); };
    $('#dock-clear').onclick = () => { getState().selected = []; changed(); };
    for (const [id, key] of [['story', 'storyDraft'], ['avoid', 'avoidDraft'], ['preference', 'preference']]) $(`#${id}`).oninput = e => { getState()[key] = e.target.value; getState().revision++; changed(false); };
    $('#stage-total').onchange = e => { try { getState().stageCount = stageCount(e.target.value); changed(false); } catch (err) { toast(err.message); } };
    for (const [id, delta] of [['minus', -1], ['plus', 1]]) $(`#${id}`).onclick = () => { const s = getState(); s.stageCount = Math.max(1, s.stageCount + delta); changed(); };
    $('#origin').addEventListener('change', () => { getState().revision++; changed(false); });
    $('#display-mode').onchange = e => { getState().display = e.target.value; changed(false); };
    $('#edited-guide').onchange = e => { getState().useEditedGuide = e.target.checked; changed(false); };
    $('#plot-enabled').onchange = e => { getState().enabled = e.target.checked; invalidate(); host.clearPrompt(); changed(); };
    $('#ack-rollback').onclick = () => { getState().rollbackNotice = false; changed(); };
    $$('input[name=mode]').forEach(el => el.onchange = () => { invalidate(); getState().mode = el.value; changed(); });
    function renderChoices() {
        const s = getState();
        for (const id of ['choices', 'dock-choices']) {
            const box = $(`#${id}`); box.replaceChildren();
            for (const c of s.choices) {
                const label = element('label', null, 'choice'), check = element('input'); check.type = 'checkbox'; check.checked = s.selected.includes(c.id);
                const mark = element('span', check.checked ? String(s.selected.indexOf(c.id) + 1) : '✓', 'choice-mark'); mark.setAttribute('aria-hidden', 'true');
                const copy = element('span'); copy.append(element('strong', c.title), element('small', c.description)); label.append(check, mark, copy); box.append(label);
                check.onchange = () => { try { selectChoice(s, c.id, check.checked); changed(); } catch (e) { check.checked = false; toast(e.message); } };
            }
            if (!s.choices.length) box.append(element('p', '点击生成候选，看看这一阶段可以怎么继续。', 'helper'));
        }
    }
    function render() {
        const s = getState(), stage = currentStage(s), i = currentIndex(s), available = !!host.identity() && !s.storageError;
        dock.sync(access);
        $('#chat-label').textContent = available ? `当前聊天 · ${host.getContext().name2 || '群聊'}` : '先打开酒馆聊天';
        for (const id of ['stage-count', 'dock-stage-count']) $(`#${id}`).textContent = stage ? `第 ${i + 1} / ${s.stages.length} 阶段` : '尚未规划阶段';
        for (const id of ['stage-title', 'dock-stage-title']) $(`#${id}`).textContent = stage?.title || '从一个故事念头开始';
        for (const id of ['stage-description', 'dock-description']) $(`#${id}`).textContent = stage?.description || '打开大纲与设置，生成或手动添加阶段。';
        for (const id of ['prev-stage', 'dock-prev']) $(`#${id}`).disabled = i <= 0;
        for (const id of ['next-stage', 'dock-next']) $(`#${id}`).disabled = !stage || i === s.stages.length - 1;
        $('#rail-stage').textContent = stage ? String(i + 1).padStart(2, '0') : '—';
        $('#rail-selected').textContent = s.selected.length || '—';
        $('#saved-count').textContent = `${s.stages.length} 个阶段${stage ? ` · 当前：${stage.title}` : ''}`;
        $('#selection-caption').textContent = s.selected.length ? `已选 ${s.selected.length} / 2 · 按选择顺序衔接` : '可选 1–2 个方向';
        $('#dock-selection-count').textContent = `已选 ${s.selected.length} / 2`; $('#dock-clear').disabled = !s.selected.length;
        $('#pause').textContent = s.paused ? '恢复引导' : '本轮暂停'; $('#pause').setAttribute('aria-pressed', String(s.paused));
        $('#apply-choice').textContent = s.mode === 'input' ? '加入输入框 →' : '附带此引导 →';
        $('#apply-choice').disabled = !stage || s.paused || !s.enabled; $('#dock-insert').disabled = !s.selected.length || s.paused || !s.enabled;
        $('#action-note').textContent = !s.enabled ? '此聊天已关闭剧情引导' : s.paused ? '本轮已暂停引导' : '不会自动发送，也不会自动推进阶段';
        $('#dock-note').textContent = s.paused ? '本轮已暂停' : '放入输入框，不会直接发送';
        for (const [id, key] of [['story', 'storyDraft'], ['avoid', 'avoidDraft'], ['preference', 'preference'], ['stage-total', 'stageCount'], ['display-mode', 'display']]) if (root.activeElement !== $(`#${id}`)) $(`#${id}`).value = s[key];
        $('#origin').selectedIndex = s.origin === 'new' ? 1 : 0;
        $('#plot-enabled').checked = s.enabled; $('#edited-guide').checked = s.useEditedGuide; $('#rollback-notice').hidden = !s.rollbackNotice;
        $$('input[name=mode]').forEach(el => el.checked = el.value === s.mode);
        for (const id of ['reroll', 'dock-reroll', 'preview-outline', 'modify-choices', 'rewrite-stage', 'adjust-future']) $(`#${id}`).disabled = busy || !available;
        for (const id of ['reroll', 'dock-reroll']) $(`#${id}`).textContent = s.choices.length ? '↻ 换一批' : '✧ 生成候选';
        $('#cancel-generation').hidden = !busy; renderChoices();
    }
    render();
    return { toast, render, open: openMain,
        setAccess(value) { access = value; if (!access.visible) closeDock(); dock.sync(access); },
        onAccessChange(callback) { accessChange = callback; },
        reset() { cancel(); pending = null; $$('dialog[open]').forEach(d => d.close()); settingsUI.refresh(); closeDock(); render(); },
        dispose() { disposed = true; cancel(); dock.dispose(); settingsUI.dispose(); tabs.dispose(); scrollObserver.disconnect(); if (previousOverflow !== null) document.body.style.overflow = previousOverflow; clearTimeout(toastTimer); document.removeEventListener('keydown', globalKeys); document.removeEventListener('pointerdown', outside); rootNode.remove(); } };
    } catch (error) { for (const cleanup of failedCleanup.reverse()) { try { cleanup(); } catch {} } throw error; }
}
