import { startPlot } from '../index.js';
import { TavernHost } from '../src/host.js';
import { extractPreset, followReferences } from '../src/references.js';
import { mountUpdater } from '../src/updates.js';

// Reproduce a host chat layer while the extension's outer stylesheet is missing.
if (new URLSearchParams(location.search).has('hostlayer')) {
    const sheet = document.querySelector('link[href="../style.css"]').sheet;
    for (let i = sheet.cssRules.length - 1; i >= 0; i--) if (sheet.cssRules[i].selectorText === '#st-plot-root') sheet.deleteRule(i);
    const layerStyle = document.createElement('style');
    layerStyle.textContent = 'body>main{position:fixed;inset:0 60px;max-width:none;z-index:30;background:#e8eef5;overflow:auto}';
    document.head.append(layerStyle);
}

const handlers = new Map(), stores = { A: {}, B: {} }, chats = { A: [{ is_user: true, mes: '这是合成聊天的已发生事实。' }], B: [{ is_user: true, mes: '这是另一个故事。' }] };
let which = 'A', routeLog = [], seed = 0;
const pageErrors = [];
if (new URLSearchParams(location.search).has('gestures')) {
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) document.addEventListener(type, e => {
        if (e.composedPath().some(el => el.id === 'st-plot-root')) console.debug('fixture-pointer', type, e.clientX, e.clientY, e.isPrimary, e.button, e.pointerType);
    }, true);
}
window.addEventListener('error', e => pageErrors.push(e.message));
window.addEventListener('unhandledrejection', e => pageErrors.push(String(e.reason?.message || e.reason)));
if (new URLSearchParams(location.search).get('test') === '1') for (const key of ['st-plot-harness-settings', 'st-plot-harness-A', 'st-plot-harness-B']) localStorage.removeItem(key);
const settings = JSON.parse(localStorage.getItem('st-plot-harness-settings') || '{}');
for (const name of ['A', 'B']) Object.assign(stores[name], JSON.parse(localStorage.getItem('st-plot-harness-' + name) || '{}'));
const ctx = { get chat() { return chats[which]; }, get chatMetadata() { return stores[which]; }, get name2() { return `合成角色 ${which}`; }, name1: '合成玩家', characters: [{ avatar: 'syntheticA.png' }], characterId: 0,
    getCurrentChatId: () => which, extensionSettings: settings, mainApi: 'openai', chatCompletionSettings: { stream_openai: true },
    saveSettingsDebounced: () => localStorage.setItem('st-plot-harness-settings', JSON.stringify(settings)),
    saveMetadata: async () => localStorage.setItem('st-plot-harness-' + which, JSON.stringify(stores[which])),
    setExtensionPrompt: (key, content) => { ctx.injection = content; },
    loadWorldInfo: async name => ({ entries: Object.fromEntries(Array.from({ length: name.endsWith('01') ? 35 : 2 }, (_, i) => [i, { uid: i, comment: `条目 ${i + 1}`, content: `${name} 的合成设定 ${i + 1}`, constant: i % 2 === 0, position: 0 }])) }),
};
class FixtureHost extends TavernHost {
    async readSavedMetadata() { return JSON.parse(localStorage.getItem('st-plot-harness-' + which))?.['st-plot']; }
    on(name, fn) { const list = handlers.get(name) || new Set(); list.add(fn); handlers.set(name, list); return () => list.delete(fn); }
    async referenceHeader(config) {
        const boundBooks = [which === 'A' ? '合成书 01' : '合成书 02']; followReferences(config, boundBooks);
        return { identity: this.identity(), name: ctx.name2, user: ctx.name1, boundBooks,
            names: Array.from({ length: 64 }, (_, i) => `合成书 ${String(i + 1).padStart(2, '0')}`), books: Object.create(null),
            currentPreset: '合成预设', presets: { '合成预设': { entries: extractPreset({ prompts: [
                { identifier: 'style', name: '文风', content: '保持克制，允许故事留白。' },
                { identifier: 'summary', name: '摘要', content: '每轮附带摘要。' },
                { identifier: 'todo', name: '待办事项', content: '每轮附带任务列表。' },
                { identifier: 'theater', name: '小剧场', content: '每轮附加番外。' },
            ] }) }, '另一套预设': { entries: extractPreset({ prompts: [{ identifier: 'style', name: '文风', content: '轻快。' }] }) } },
            slots: { charDescription: `合成人物 ${which} 的人设`, scenario: '合成场景' }, persona: `合成玩家人设 ${which}`, chat: ctx.chat.map(m => ({ role: m.is_user ? 'user' : 'assistant', content: m.mes })), substitute: text => text,
        };
    }
}
const host = new FixtureHost(() => ctx);
async function emit(name, ...args) { for (const fn of handlers.get(name) || []) await fn(...args); }
async function switchChat(name) { which = name; document.querySelector('#chat-name').textContent = `合成聊天 ${name}`; await emit('CHAT_CHANGED'); }
const response = async (args, route) => {
    routeLog.push({ route, messages: args.messages });
    const payload = [...args.messages].reverse().find(x => x.role === 'user' && x.content.startsWith('{'));
    const job = JSON.parse(payload.content), choices = job.task === 'choices'; seed++;
    const text = JSON.stringify({ [choices ? 'choices' : 'stages']: Array.from({ length: choices ? 5 : job.count }, (_, i) => ({ title: `${choices ? '方向' : '阶段'} ${seed}-${i + 1}`, description: `合成内容 ${i + 1}：给角色具体互动空间，不替玩家做决定。` })) });
    args.onChunk?.(text); await new Promise(r => setTimeout(r, 35)); return text;
};
let app = await startPlot(host, { main: args => response(args, 'main'), custom: args => response(args, 'secondary') });
document.querySelector('#fixture-settings-toggle').onclick = () => { document.querySelector('#fixture-settings').hidden = false; };
document.querySelector('#fixture-settings-close').onclick = () => { document.querySelector('#fixture-settings').hidden = true; };
document.querySelector('#extensionsMenuButton').onclick = e => { e.stopPropagation(); const menu = document.querySelector('#extensionsMenu'); menu.hidden = !menu.hidden; };
document.addEventListener('click', e => { if (!e.target.closest?.('#extensionsMenuButton')) document.querySelector('#extensionsMenu').hidden = true; });
document.querySelector('#switch-a').onclick = () => switchChat('A'); document.querySelector('#switch-b').onclick = () => switchChat('B');
document.querySelector('#send-test').onclick = async () => {
    await emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
    if (host.getDraft().trim()) { ctx.chat.push({ is_user: true, mes: host.getDraft() }); host.setDraft(''); await emit('MESSAGE_SENT'); }
    ctx.chat.push({ is_user: false, mes: '这是合成回复。' }); await emit('GENERATION_ENDED'); await emit('MESSAGE_RECEIVED', ctx.chat.length - 1, 'normal');
};
const results = document.querySelector('#results'); results.textContent = '正式界面已加载，可以通过右侧悬浮条或打开按钮体验。';
const tick = () => new Promise(r => setTimeout(r, 50));
const root = () => document.getElementById('st-plot-root').shadowRoot;
const q = selector => root().querySelector(selector);
const click = selector => { const e = q(selector); if (!e) throw new Error(`missing ${selector}`); if (e.disabled) throw new Error(`disabled ${selector}`); e.click(); };
const fill = (selector, value) => { const e = q(selector); e.value = value; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
function check(value, label) { if (!value) throw new Error(label); results.textContent += `\n✓ ${label}`; }
async function waitUntil(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await tick(); } throw new Error('等待界面超时'); }

async function verify() {
    results.textContent = '开始隔离浏览器验收';
    check(getComputedStyle(document.getElementById('st-plot-root')).backgroundColor === 'rgba(0, 0, 0, 0)', '悬浮根层透明，不覆盖酒馆画面');
    document.querySelector('#fixture-settings-toggle').click();
    document.querySelector('#st-plot-access .inline-drawer-toggle').click();
    const entry = document.querySelector('#st-plot-settings-entry');
    check(entry.getBoundingClientRect().width > 200, '扩展入口不继承酒馆的窄按钮宽度');
    entry.click();
    check(q('#main-overlay').matches(':modal'), '扩展入口以顶层模态打开主面板');
    const closeRect = q('#close-main').getBoundingClientRect();
    check(document.elementFromPoint(closeRect.x + closeRect.width / 2, closeRect.y + closeRect.height / 2) === document.getElementById('st-plot-root'), '打开按钮不被4005层酒馆设置挡住');
    click('#close-main'); await tick();
    const toggleRect = q('#dock-toggle').getBoundingClientRect();
    check(document.elementFromPoint(toggleRect.x + toggleRect.width / 2, toggleRect.y + toggleRect.height / 2) === document.getElementById('st-plot-root'), '悬浮条在酒馆设置上方可命中');
    document.querySelector('#st-plot-dock-visible').click();
    check(q('#story-dock').hidden && settings['st-plot-access'].visible === false, '关闭悬浮入口立即隐藏并独立保存');
    document.querySelector('#extensionsMenuButton').click(); document.querySelector('#st-plot-wand').click();
    await waitUntil(() => q('#main-overlay').open);
    check(document.querySelector('#extensionsMenu').hidden, '隐藏悬浮后魔法棒仍能打开，并收起宿主菜单');
    click('#close-main'); await tick();
    document.querySelector('#st-plot-dock-visible').click();
    await emit('APP_READY');
    check(document.querySelectorAll('#st-plot-wand').length === 1 && document.querySelectorAll('#st-plot-access').length === 1, 'APP_READY重复挂接不产生重复入口');
    q('#dock-drag').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    check(q('#story-dock').dataset.side === 'left', '键盘可将悬浮入口移到左侧');
    document.querySelector('#fixture-settings-close').click();
    app.open(1); fill('#story', '合成慢热故事'); fill('#stage-total', '13');
    click('#preview-outline'); await waitUntil(() => q('#outline-dialog').open && !q('#adopt-outline').hidden);
    check(!stores.A['st-plot'].stages.length, '生成只预览，不覆盖旧大纲');
    click('#adopt-outline'); check(q('#stage-count').textContent.includes('/ 13'), '采用 13 个阶段');
    check(q('#action-note').hidden && !q('#action-note').textContent && q('#dock-note').hidden, '默认引导说明留空隐藏');
    click('#pause'); check(!q('#action-note').hidden && !q('#dock-note').hidden && q('#dock-note').textContent === '本轮已暂停', '暂停提示主面板与悬浮同步可见');
    click('#pause'); check(q('#action-note').hidden && q('#dock-note').hidden, '恢复后隐藏暂停提示');
    q('input[name=mode][value=attach]').click(); check(q('#apply-choice').textContent.includes('下次发送时附带'), '附带模式按钮说明下次发送行为');
    q('input[name=mode][value=input]').click();
    click('#reroll'); await waitUntil(() => q('#choices input')); check(q('#choices').querySelectorAll('input').length === 5, '真实生成入口显示五个候选');
    q('#choices input').click(); q('#choices input:nth-of-type(1)');
    const choices = q('#choices').querySelectorAll('input'); choices[1].click();
    check(q('#dock-choices').querySelectorAll('input:checked').length === 2, '主面板与悬浮窗双选同步');
    q('#choices').querySelectorAll('input')[2].click(); check(q('#choices').querySelectorAll('input:checked').length === 2, '第三项被阻止');
    check(q('#toast').closest('dialog') === q('#main-overlay'), '模态主面板内的提示仍可见');
    host.setDraft('我的原文'); click('#apply-choice'); check(host.getDraft().startsWith('我的原文\n\n'), '输入保留原文');
    const first = host.getDraft(); app.open(); click('#apply-choice'); check(host.getDraft() === first, '重复输入不重复引导');
    await tick(); check(document.activeElement.id === 'send_textarea', '输入后包含延迟关闭事件的焦点仍在酒馆输入框');
    document.querySelector('#send-test').click(); await tick(); check(stores.A['st-plot'].selected.length === 0 && stores.A['st-plot'].currentId === stores.A['st-plot'].stages[0].id, '成功清理选择，阶段不自动推进');
    await switchChat('B'); check(q('#stage-count').textContent === '尚未规划阶段', 'B 聊天为空白独立状态');
    await switchChat('A'); check(q('#stage-count').textContent.includes('/ 13'), '切回 A 恢复大纲');
    app.open(1); click('#open-generation-settings'); await waitUntil(() => q('#reference-dialog').open);
    check(!q('#ref-char-enabled'), '没有 Char 人设面板');
    q('#ref-library').open = true; check(q('#ref-books').querySelectorAll('input').length === 12, '64 本书按 12 本分页');
    check(q('#ref-entries').querySelectorAll('input').length === 20, '35 条选中书内容首屏显示 20 条');
    click('#ref-more-entries'); check(q('#ref-entries').querySelectorAll('input').length === 35, '继续查看其余条目');
    fill('#ref-library-search', '64'); check(q('#ref-books').querySelectorAll('input').length === 1, '书库跨页搜索');
    click('#ref-model-tab'); check(q('#ref-preset-entries').querySelectorAll('input:checked').length === 1, '摘要、待办、小剧场默认排除');
    click('#ref-route-custom'); fill('#ref-main-url', 'https://example.com/v1'); fill('#ref-main-model', 'synthetic-main');
    click('#ref-main-preset-new'); fill('#ref-main-preset-name', '合成自定义'); click('#ref-main-preset-create');
    q('#ref-secondary-enabled').click(); fill('#ref-secondary-model', 'synthetic-side'); fill('#ref-secondary-url', 'https://example.com/v1');
    check(q('#ref-main-model').value === 'synthetic-main', '主副参数互不覆盖');
    click('#ref-route-main'); click('#ref-save'); await waitUntil(() => !q('#reference-dialog').open);
    check(settings['st-plot-access'].side === 'left', '保存模型设置不覆盖悬浮位置');
    click('#play-tab'); click('#reroll'); await waitUntil(() => !q('#request-dialog').open); check(routeLog.at(-1).route === 'secondary', '换批实际使用副 API');
    app.dispose(); await tick(); check(!document.getElementById('st-plot-root') && !document.getElementById('st-plot-wand') && !document.getElementById('st-plot-access'), '卸载清理控件、魔法棒入口与事件'); check(pageErrors.length === 0, '包含延迟关闭事件的卸载没有页面异常');
    app = await startPlot(host, { main: args => response(args, 'main'), custom: args => response(args, 'secondary') });
    check(q('#story-dock').dataset.side === 'left', '重新挂载恢复悬浮位置');
    check(q('#stage-count').textContent.includes('/ 13'), '重新挂载恢复聊天状态');
    check(document.querySelectorAll('#st-plot-root').length === 1, '重新挂载没有重复浮层');
    stores.B['st-plot'] = { version: 99 }; await switchChat('B');
    check(!q('#stage-count').textContent.includes('/ 13'), '损坏 B 数据时不残留 A 的大纲');
    await emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false); check(!ctx.injection, '损坏聊天不注入上一聊天引导');
    await switchChat('A');
    app.open(1); click('#open-generation-settings'); await waitUntil(() => q('#reference-dialog').open);
    click('#ref-model-tab'); click('#ref-route-custom');
    check(!q('#ref-save-status').textContent.includes('未保存'), '自动保存连接不误报未保存');
    const saveCredential = host.saveCredential, originalCredentialId = settings['st-plot'].primary.credentialId, originalCredential = host.credentials.get(originalCredentialId);
    host.saveCredential = () => { throw new Error('synthetic save failure'); };
    fill('#ref-main-key', 'synthetic-failed-key');
    host.saveCredential = saveCredential;
    fill('#ref-main-model', 'synthetic-after-key-failure');
    check(q('#ref-save-status').textContent.includes('密钥未保存'), '模型自动保存不掩盖密钥保存失败');
    click('#ref-save'); await tick(); check(q('#reference-dialog').open, '密钥未保存时不关闭设置或假报保存成功');
    fill('#ref-main-key', 'synthetic-recovered-key');
    check(!q('#ref-save-status').textContent.includes('未保存'), '重新填写密钥保存成功后解除失败状态');
    check(settings['st-plot'].primary.credentialId !== originalCredentialId && host.credentials.get(originalCredentialId) === originalCredential, '密钥失败重试仍分离原凭据，不回写共享预设');
    fill('#ref-main-url', 'https://models.example.test/v1'); fill('#ref-main-key', 'synthetic-main-only');
    fill('#ref-secondary-key', 'synthetic-secondary-only');
    check(settings['st-plot'].primary.endpoint === 'https://models.example.test/v1', 'API 地址输入立即自动保存，不依赖聊天保存');
    const persistedHost = new FixtureHost(() => ctx);
    check(persistedHost.credentials.get(persistedHost.settings().primary.credentialId) === 'synthetic-main-only' && persistedHost.credentials.get(persistedHost.settings().secondary.credentialId) === 'synthetic-secondary-only', '新宿主恢复主副密钥且彼此独立');
    click('#ref-main-preset-new'); fill('#ref-main-preset-name', '密钥隔离预设'); click('#ref-main-preset-create');
    fill('#ref-main-key', 'synthetic-edited-only');
    fill('#ref-secondary-api-preset', '密钥隔离预设');
    check(host.credentials.get(settings['st-plot'].secondary.credentialId) === 'synthetic-main-only', '保存预设后再次编辑主密钥不改写预设或副连接');
    fill('#ref-main-api-preset', '密钥隔离预设');
    const fetchOriginal = window.fetch;
    window.fetch = async (url, options) => {
        if (url === 'https://models.example.test/v1/models') return new Response(JSON.stringify({data:[{id:'synthetic-a'},{id:'synthetic-b'}]}),{status:200});
        return fetchOriginal(url, options);
    };
    try {
        click('#ref-main-test'); await waitUntil(() => !q('#ref-main-model-select').hidden);
        fill('#ref-main-model-select', 'synthetic-b');
        check(settings['st-plot'].primary.model === 'synthetic-b', '模型列表下拉选择与手动输入同步自动保存');
        let finishLate;
        window.fetch = () => new Promise(resolve => { finishLate = resolve; });
        click('#ref-main-test'); fill('#ref-main-url', 'https://changed.example.test/v1');
        finishLate(new Response(JSON.stringify({data:[{id:'late-model'}]}), {status:200})); await tick();
        check(q('#ref-main-model-select').hidden && settings['st-plot'].primary.model === 'synthetic-b', '换地址后旧模型列表晚到不会回写');
        fill('#ref-main-url', 'https://models.example.test/v1');
        click('#ref-main-key-clear');
        check(!host.credentials.has(settings['st-plot'].primary.credentialId) && host.credentials.get(settings['st-plot'].secondary.credentialId) === 'synthetic-main-only', '同一预设清除主密钥不清除副密钥');
    } finally { window.fetch = fetchOriginal; }
    click('#ref-cancel'); await tick();
    click('#open-generation-settings'); await waitUntil(() => q('#reference-dialog').open);
    check(q('#ref-main-url').value === 'https://models.example.test/v1' && q('#ref-main-model').value === 'synthetic-b', '关闭设置不撤回已自动保存的连接');
    check(q('#ref-save-status').textContent === '', '重开设置默认状态留空');
    click('#ref-user-enabled'); check(q('#ref-save-status').textContent.includes('有未保存的调整'), '参考资料修改保留未保存提示');
    click('#ref-route-main'); check(q('#ref-save-status').textContent.includes('有未保存的调整'), '连接自动保存不掩盖参考资料未保存状态');
    click('#ref-cancel'); click('#close-main'); await tick();
    click('#dock-toggle'); check(!q('#dock-stage-page').hidden && q('#dock-options-page').hidden, '阶段入口仅打开阶段页');
    await new Promise(resolve => setTimeout(resolve, 450));
    const panelRect = q('#dock-panel').getBoundingClientRect();
    check(document.elementFromPoint(panelRect.x + panelRect.width / 2, panelRect.y + panelRect.height / 2) === document.getElementById('st-plot-root'), '悬浮展开页中心实际可命中，未被宿主聊天盖住');
    const stageHeight = q('#dock-panel').getBoundingClientRect().height;
    click('#dock-options'); check(q('#dock-stage-page').hidden && !q('#dock-options-page').hidden && !q('#dock-panel').hidden, '另一个悬浮入口切页而非关窗');
    check(q('#dock-panel').getBoundingClientRect().height === stageHeight, '阶段和选项共用相同高度外框');
    click('#dock-options'); check(q('#dock-panel').hidden, '点击当前悬浮入口收起');
    // Touch pointer semantics, including tap-versus-drag; real device checks remain separate.
    const rail = q('.dock-rail'), handle = q('#dock-drag'), rect = rail.getBoundingClientRect();
    const pointer = (target, type, x, y) => target.dispatchEvent(new PointerEvent(type, {bubbles:true,composed:true,pointerId:71,pointerType:'touch',isPrimary:true,button:0,clientX:x,clientY:y}));
    pointer(handle,'pointerdown',rect.x+20,rect.y+10); pointer(window,'pointermove',window.innerWidth-25,rect.y+45);
    check(parseFloat(rail.style.left)>window.innerWidth/2, '触控拖动过程中可水平跟随');
    pointer(window,'pointerup',window.innerWidth-25,rect.y+45);
    check(settings['st-plot-access'].side === 'right', '触控松手后吸附并保存右侧');
    app.dispose(); await tick();
    let failUI = true;
    window.fetch = async (url, options) => { if (String(url).endsWith('/ui/shell.html') && failUI) return new Response('', {status:503}); return fetchOriginal(url, options); };
    try {
        app = await startPlot(new FixtureHost(() => ctx), { main: args => response(args, 'main'), custom: args => response(args, 'secondary') });
        check(!document.getElementById('st-plot-root') && !!document.getElementById('st-plot-settings-entry'), '主界面加载失败仍保留扩展入口');
        failUI = false; document.getElementById('st-plot-settings-entry').click(); await waitUntil(() => document.getElementById('st-plot-root')?.shadowRoot.querySelector('#main-overlay').open);
        check(q('#main-overlay').open, '入口可重试加载并打开');
    } finally { window.fetch = fetchOriginal; }
    const updateRoot = document.createElement('div');
    updateRoot.innerHTML = '<button id="ref-check-update"></button><button id="ref-apply-update" hidden></button><button id="ref-reload-update" hidden></button><span id="ref-update-status"></span>';
    const u = id => updateRoot.querySelector(id);
    let resolveCheck, checks = 0, fail = false;
    const updateUI = mountUpdater(updateRoot, { updater: {
        check: () => { checks++; return new Promise(resolve => { resolveCheck = resolve; }); },
        update: async () => { if (fail) throw new Error('合成更新失败'); },
    }, canReload: () => false, reload: () => { throw new Error('不可刷新合成页'); } });
    u('#ref-check-update').click(); u('#ref-check-update').click();
    check(checks === 1 && u('#ref-check-update').disabled, '检查更新期间禁用重复点击');
    resolveCheck({ isUpToDate: false, currentCommitHash: 'old' }); await tick();
    check(!u('#ref-apply-update').hidden && u('#ref-update-status').textContent.includes('有更新'), '检查完成展示真正更新操作');
    fail = true; u('#ref-apply-update').click(); await tick();
    check(u('#ref-apply-update').hidden && !u('#ref-check-update').disabled && u('#ref-update-status').textContent === '合成更新失败', '更新失败保留错误并恢复检查入口');
    u('#ref-check-update').click(); resolveCheck({ isUpToDate: false, currentCommitHash: 'old' }); await tick();
    fail = false; u('#ref-apply-update').click(); await tick();
    check(!u('#ref-reload-update').hidden && u('#ref-check-update').hidden, '更新完成展示刷新生效，不自动刷新');
    u('#ref-reload-update').click(); check(u('#ref-update-status').textContent.includes('请先保存或取消'), '未保存修改阻止更新后的刷新');
    updateUI.dispose();
    app.open(1); results.dataset.passed = 'true'; results.textContent += '\n全部浏览器验收完成';
}
if (new URLSearchParams(location.search).get('test') === '1') verify().catch(e => { results.textContent += '\nFAIL: ' + e.message; results.dataset.passed = 'false'; console.error(e); });
