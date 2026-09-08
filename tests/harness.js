import { startPlot } from '../index.js';
import { TavernHost } from '../src/host.js';
import { extractPreset, followReferences } from '../src/references.js';

const handlers = new Map(), stores = { A: {}, B: {} }, chats = { A: [{ is_user: true, mes: '这是合成聊天的已发生事实。' }], B: [{ is_user: true, mes: '这是另一个故事。' }] };
let which = 'A', routeLog = [], seed = 0;
const pageErrors = [];
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
    app.open(1); fill('#story', '合成慢热故事'); fill('#stage-total', '13');
    click('#preview-outline'); await waitUntil(() => q('#outline-dialog').open && !q('#adopt-outline').hidden);
    check(!stores.A['st-plot'].stages.length, '生成只预览，不覆盖旧大纲');
    click('#adopt-outline'); check(q('#stage-count').textContent.includes('/ 13'), '采用 13 个阶段');
    click('#reroll'); await waitUntil(() => q('#choices input')); check(q('#choices').querySelectorAll('input').length === 5, '真实生成入口显示五个候选');
    q('#choices input').click(); q('#choices input:nth-of-type(1)');
    const choices = q('#choices').querySelectorAll('input'); choices[1].click();
    check(q('#dock-choices').querySelectorAll('input:checked').length === 2, '主面板与悬浮窗双选同步');
    q('#choices').querySelectorAll('input')[2].click(); check(q('#choices').querySelectorAll('input:checked').length === 2, '第三项被阻止');
    host.setDraft('我的原文'); click('#apply-choice'); check(host.getDraft().startsWith('我的原文\n\n'), '输入保留原文');
    const first = host.getDraft(); app.open(); click('#apply-choice'); check(host.getDraft() === first, '重复输入不重复引导');
    check(document.activeElement.id === 'send_textarea', '输入后焦点回酒馆输入框');
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
    click('#play-tab'); click('#reroll'); await waitUntil(() => !q('#request-dialog').open); check(routeLog.at(-1).route === 'secondary', '换批实际使用副 API');
    app.dispose(); await tick(); check(!document.getElementById('st-plot-root'), '卸载清理控件与事件'); check(pageErrors.length === 0, '包含延迟关闭事件的卸载没有页面异常');
    app = await startPlot(host, { main: args => response(args, 'main'), custom: args => response(args, 'secondary') });
    check(q('#stage-count').textContent.includes('/ 13'), '重新挂载恢复聊天状态');
    check(document.querySelectorAll('#st-plot-root').length === 1, '重新挂载没有重复浮层');
    stores.B['st-plot'] = { version: 99 }; await switchChat('B');
    check(!q('#stage-count').textContent.includes('/ 13'), '损坏 B 数据时不残留 A 的大纲');
    await emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false); check(!ctx.injection, '损坏聊天不注入上一聊天引导');
    await switchChat('A');
    app.open(1); results.dataset.passed = 'true'; results.textContent += '\n全部浏览器验收完成';
}
if (new URLSearchParams(location.search).get('test') === '1') verify().catch(e => { results.textContent += '\nFAIL: ' + e.message; results.dataset.passed = 'false'; console.error(e); });
