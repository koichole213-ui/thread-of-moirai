import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, initialSettings, parseResult, stageCount, selectChoice, guide, adoptStages, moveStage, removeStage, reorderStage, visibleStageName, replaceOwnedDraft, finishRound, RequestGate, clone, stateKey } from '../src/core.js';
import { extractPreset, presetChecked, extraCategory, followReferences, rememberEntries, buildMessages } from '../src/references.js';
import { routeFor, Generator } from '../src/generation.js';
import { RoundBridge, cleanPromptText } from '../src/rounds.js';
import { TavernHost, chatIdentity } from '../src/host.js';
import { buildApiRequest } from '../vendor/st-theater/api-client.js';
import { normalizeAccess } from '../src/access.js';

test('损坏入口偏好可恢复，位置越界被限制，不带入其他设置', () => {
    for (const value of [null, undefined, false, 'bad']) assert.deepEqual(normalizeAccess(value), { visible: true, tuck: true, side: 'right', position: .4 });
    assert.deepEqual(normalizeAccess({ visible: false, tuck: false, side: 'left', position: 9, primary: {} }), { visible: false, tuck: false, side: 'left', position: 1 });
    assert.equal(normalizeAccess({ position: -8 }).position, 0);
    assert.equal(normalizeAccess({ position: Infinity }).position, .4);
});

const stages = n => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, title: `阶段${i}`, description: `阶段内容${i}` }));
const story = () => ({ ...initialState(), stages: stages(3), currentId: 's1', story: '慢热', avoid: '不替玩家决定', choices: stages(5) });
const refs = () => ({ currentPreset: '预设', presets: { '预设': { entries: extractPreset({ prompts: [{ identifier: 'style', name: '文风', content: '克制' }, { identifier: 'summary', name: '摘要', content: '输出摘要' }] }) } }, books: {}, slots: { charDescription: '角色设定', scenario: '当前场景' }, persona: '玩家人设', chat: [{ role: 'user', content: '实际发生' }], substitute: x => x });

test('数量不固定；错误/截断/重复返回不被采用，额外字段不会进入大纲', () => {
    for (const n of [1, 12, 21, 101]) assert.equal(parseResult(JSON.stringify({ stages: stages(n), summary: '附加内容' }), 'outline', n).length, n);
    for (const n of ['', 0, -1, 1.5, NaN]) assert.throws(() => stageCount(n));
    assert.throws(() => parseResult('{"stages":[', 'outline', 1));
    assert.throws(() => parseResult(JSON.stringify({ stages: stages(2) }), 'outline', 1));
    assert.throws(() => parseResult(JSON.stringify({ choices: stages(3) }), 'choices'));
    assert.equal(parseResult('```json\n' + JSON.stringify({ choices: stages(4) }) + '\n```', 'choices').length, 4);
});
test('最多双选按序、未选与未来阶段不进入引导、阶段只手动改变', () => {
    const s = story(); selectChoice(s, 's2', true); selectChoice(s, 's0', true);
    assert.throws(() => selectChoice(s, 's3', true)); assert.deepEqual(s.selected, ['s2', 's0']);
    const g = guide(s); assert(g.indexOf('本轮方向1：阶段2') < g.indexOf('本轮方向2：阶段0'));
    assert(!g.includes('阶段内容4')); assert.equal(s.currentId, 's1');
    s.selected = []; assert(!guide(s).includes('阶段内容2')); s.paused = true; assert.equal(guide(s), '');
});
test('阶段重排保留身份；单阶段/后续采用保留当前与已完成内容', () => {
    const s = story(); reorderStage(s, 's1', -1); assert.equal(s.currentId, 's1');
    adoptStages(s, [{ id: 'new', title: '改写', description: '重写内容' }], 'stage'); assert.equal(s.stages[0].id, 's1');
    adoptStages(s, stages(1), 'future'); assert.equal(s.stages[0].title, '改写');
    removeStage(s, 's0'); assert.equal(s.currentId, 's1');
    assert.equal(moveStage(s, 'nonexistent'), false);
});
test('逐阶段揭晓搜索只拿遮蔽标题，不泄露未来', () => {
    const s = story(); s.display = 'current'; assert.equal(visibleStageName(s, 2), '尚未揭晓'); assert.equal(visibleStageName(s, 1), '阶段1');
});
test('输入只替换准确归属段，用户自己写的相似标记和修改后的内容保留', () => {
    const original = '台词\n【本轮剧情引导】我自己写的【引导结束】';
    const a = replaceOwnedDraft(original, null, '插件引导A'); const b = replaceOwnedDraft(a.text, a.owned, '插件引导B');
    assert.equal(b.text, original + '\n\n插件引导B'); assert.throws(() => replaceOwnedDraft('台词+用户修改的引导', a.owned, '新引导'));
});
test('成功清空临时选择但不动阶段；运行中新增偏好保留', () => {
    const s = story(); s.selected = ['s1']; s.preference = '本轮'; s.paused = true;
    const shot = clone(s); finishRound(s, shot); assert.equal(s.currentId, 's1'); assert.deepEqual(s.selected, []); assert.equal(s.preference, ''); assert.equal(s.paused, false);
    s.preference = '后补'; finishRound(s, shot); assert.equal(s.preference, '后补');
});
test('世界书跟随替换自动组，保留手选；新增条目不会悄悄参与', () => {
    const s = initialSettings(); s.selectedBooks = ['A', '手选']; s.followedBooks = ['A']; followReferences(s, ['B']);
    assert.deepEqual(s.selectedBooks, ['手选', 'B']); rememberEntries(s, 'B', [{ uid: '1' }]); rememberEntries(s, 'B', [{ uid: '1' }, { uid: '2' }]);
    assert.equal(s.entryStates[stateKey('B', '1')], true); assert.equal(s.entryStates[stateKey('B', '2')], false);
});
test('创作预设按真实启用顺序，过滤专用任务可逐条恢复，混合规则不删', () => {
    const entries = extractPreset({ prompts: [{ identifier: 'a', content: '摘要是大纲概要', name: '世界观' }, { identifier: 'b', name: '摘要', content: '请总结' }], prompt_order: [{ character_id: 100001, order: [{ identifier: 'b', enabled: true }, { identifier: 'a', enabled: false }] }] });
    assert.equal(entries[0].id, 'b'); const s = initialSettings(); assert.equal(presetChecked(s, 'P', entries[0]), false);
    s.presetStates[stateKey('P', 'b')] = true; assert.equal(presetChecked(s, 'P', entries[0]), true); assert.equal(presetChecked(s, 'Q', entries[0]), false);
    assert.equal(extraCategory(entries[1]), ''); assert.equal(entries[1].enabledInST, false);
});
test('最终请求包含所选人物和世界书，不含关闭聊天/被排除任务/未来阶段', () => {
    const s = story(), config = initialSettings(), r = refs(); config.selectedBooks = ['书']; r.books['书'] = [{ uid: '1', content: '世界设定', position: 0 }];
    s.chatEnabled = false; const result = JSON.stringify(buildMessages({ settings: config, refs: r, state: s, task: 'choices', count: 5 }));
    for (const content of ['角色设定', '玩家人设', '世界设定', '克制', '阶段内容1']) assert(result.includes(content));
    for (const content of ['实际发生', '输出摘要', '阶段内容2']) assert(!result.includes(content));
});
test('主副分流只用于换批/修改；独立请求不继承酒馆采样参数', () => {
    const s = initialSettings(); s.secondaryEnabled = true;
    assert.equal(routeFor(s, 'choices', true).profile.credentialId, s.secondary.credentialId);
    assert.equal(routeFor(s, 'outline', true).route, 'main'); assert.equal(routeFor(s, 'choices', false).route, 'main');
    const req = buildApiRequest({ url: 'https://example.com', model: 'test', key: '', messages: [{ role: 'user', content: 'synthetic' }], temperature: 8, top_p: .8 });
    for (const key of ['temperature', 'top_p', 'seed', 'reasoning_effort']) assert(!Object.hasOwn(req.body, key));
});
test('请求取消、切聊天、改阶段后晚返回不能采用', async () => {
    const gate = new RequestGate(), t = gate.start('A', 1); assert(!gate.valid(t, 'B', 1)); assert(!gate.valid(t, 'A', 2)); gate.cancel(); assert(t.signal.aborted);
    let resolve, identity = 'A'; const s = story(); const host = { identity: () => identity, references: async () => refs(), getContext: () => ({ mainApi: 'openai' }), credentials: new Map() };
    const generator = new Generator(host, { main: () => new Promise(r => { resolve = r; }) });
    const p = generator.generate({ state: s, settings: initialSettings(), task: 'choices', count: 5 });
    await new Promise(r => setImmediate(r)); identity = 'B'; resolve(JSON.stringify({ choices: stages(5) }));
    await assert.rejects(p, { name: 'AbortError' }); assert.equal(s.choices.length, 5);
});
function mockHost() {
    const handlers = {}, ctx = { mainApi: 'openai', chat: [{ is_user: true, mes: '你好' }], chatMetadata: {}, extensionSettings: {}, saveMetadata: async () => {}, saveSettingsDebounced() {}, getCurrentChatId: () => 'chatA', characters: [{ avatar: 'A.png' }], characterId: 0 };
    const host = new TavernHost(() => ctx); host.on = (name, fn) => { handlers[name] = fn; return () => delete handlers[name]; };
    host.readSavedMetadata = async () => clone(ctx.chatMetadata['st-plot']);
    let prompt = '', draft = '';
    host.setPrompt = text => { prompt = text; }; host.getDraft = () => draft; host.setDraft = text => { draft = text; };
    return { host, ctx, handlers, prompt: () => prompt };
}
test('按聊天元数据恢复；A 的保存不能写到 B；保存异常会报告', async () => {
    const { host, ctx } = mockHost(); const a = host.identity(); await host.save(story(), a); assert.equal(host.load().currentId, 's1');
    ctx.getCurrentChatId = () => 'chatB'; ctx.chatMetadata = {}; assert.equal(host.load().stages.length, 0);
    await assert.rejects(host.save(story(), a)); ctx.saveMetadata = async () => { throw new Error('offline'); }; await assert.rejects(host.save(story(), host.identity()));
    assert.notEqual(chatIdentity(ctx), a);
});
test('回复成功/失败与重生成快照生命周期，删除操作不会自动推进', () => {
    const { host, handlers, ctx, prompt } = mockHost(); const s = story(); s.mode = 'attach'; s.preference = '原轮';
    const bridge = new RoundBridge(host, () => s, () => {}, () => {});
    handlers.GENERATION_AFTER_COMMANDS('normal', {}, false); const original = prompt(); assert(original.includes('原轮'));
    handlers.GENERATION_STOPPED(); assert.equal(s.preference, '原轮'); assert.equal(prompt(), '');
    handlers.GENERATION_AFTER_COMMANDS('normal', {}, false); ctx.chat.push({ is_user: false, mes: '回复' }); handlers.MESSAGE_RECEIVED(1, 'normal');
    assert.equal(s.preference, ''); assert.equal(s.currentId, 's1');
    s.preference = '后改'; handlers.GENERATION_AFTER_COMMANDS('regenerate', {}, false); assert.equal(prompt(), original);
    handlers.GENERATION_STOPPED(); s.useEditedGuide = true; handlers.GENERATION_AFTER_COMMANDS('regenerate', {}, false); assert(prompt().includes('后改'));
    handlers.GENERATION_STOPPED(); handlers.MESSAGE_DELETED(); assert(s.rollbackNotice); assert.equal(s.currentId, 's1'); bridge.dispose(); assert.equal(Object.keys(handlers).length, 0);
});
test('输入引导只保留当前轮，旧轮不污染历史请求；原文字相同部分保留', () => {
    assert.equal(cleanPromptText('前文G中段G结尾', ['G'], 'G'), '前文中段G结尾');
    assert.equal(cleanPromptText('前文G中段G结尾', ['G']), '前文中段结尾');
});
test('酒馆先 ENDED 再 RECEIVED 的流式成功能清理；流式错误收到局部文本也保留选择', () => {
    const { host, handlers, ctx } = mockHost(); const s = story(); s.mode = 'attach'; s.preference = '保留到成功';
    const bridge = new RoundBridge(host, () => s, () => {}, () => {});
    handlers.GENERATION_AFTER_COMMANDS('normal', {}, false); ctx.chat.push({ is_user: false, mes: '完整回复' });
    handlers.GENERATION_ENDED(); handlers.MESSAGE_RECEIVED(1, 'normal'); assert.equal(s.preference, '');
    s.preference = '失败后保留'; handlers.GENERATION_AFTER_COMMANDS('normal', {}, false);
    ctx.streamingProcessor = { isStopped: true }; handlers.GENERATION_ENDED(); handlers.MESSAGE_RECEIVED(1, 'normal'); assert.equal(s.preference, '失败后保留'); bridge.dispose();
});
test('暂停覆盖重生成但保留原快照；quiet 不继承共享引导也不清空当前选择', () => {
    const { host, handlers, ctx, prompt } = mockHost(); const s = story(); s.mode = 'attach'; s.preference = '原偏好';
    const bridge = new RoundBridge(host, () => s, () => {}, () => {});
    handlers.GENERATION_AFTER_COMMANDS('normal', {}, false); const original = prompt(); handlers.GENERATION_STOPPED();
    s.paused = true; handlers.GENERATION_AFTER_COMMANDS('regenerate', {}, false); assert.equal(prompt(), ''); handlers.GENERATION_STOPPED();
    s.paused = false; handlers.GENERATION_AFTER_COMMANDS('regenerate', {}, false); assert.equal(prompt(), original);
    handlers.GENERATION_AFTER_COMMANDS('quiet', {}, false); assert.equal(prompt(), '');
    ctx.chat.push({ is_user: false, mes: '无关任务的内容' }); handlers.MESSAGE_RECEIVED(1, 'quiet'); assert.equal(s.preference, '原偏好');
    bridge.dispose();
});
test('取消预设资料标记后不会被自动补齐', () => {
    const r = refs(), s = initialSettings();
    r.presets['预设'].entries.push(...extractPreset({ prompts: [{ identifier: 'charDescription', marker: true }, { identifier: 'chatHistory', marker: true }, { identifier: 'personaDescription', marker: true }] }));
    for (const id of ['charDescription', 'chatHistory', 'personaDescription']) s.presetStates[stateKey('预设', id)] = false;
    const text = JSON.stringify(buildMessages({ settings: s, refs: r, state: story(), task: 'choices', count: 5 }));
    for (const forbidden of ['角色设定', '玩家人设', '实际发生']) assert(!text.includes(forbidden));
});
test('当前卡明确取消的绑定书不会在生成时补回；新卡才重新跟随', () => {
    const s = initialSettings(); followReferences(s, ['A']); s.selectedBooks = []; followReferences(s, ['A']); assert.deepEqual(s.selectedBooks, []);
    followReferences(s, ['B']); assert.deepEqual(s.selectedBooks, ['B']);
});
test('宿主吞掉保存错误时通过回读发现失败；设置事务不污染活动存储', async () => {
    const { host, ctx } = mockHost(); const s = story(); await host.save(s, host.identity()); const previous = clone(ctx.chatMetadata['st-plot']);
    host.readSavedMetadata = async () => previous;
    await assert.rejects(host.save({ ...s, origin: 'new' }, host.identity(), { rollbackOnFailure: true }));
    assert.equal(ctx.chatMetadata['st-plot'].origin, 'continue'); assert.equal(host.load().origin, 'continue');
});
test('OpenAI 文本中间事件和无关 raw 请求不清理提示，最终聊天拼装后才清理', () => {
    const { host, handlers, prompt } = mockHost(); const s = story(); s.mode = 'attach';
    const bridge = new RoundBridge(host, () => s, () => {}, () => {});
    handlers.GENERATION_AFTER_COMMANDS('normal', {}, false); const injected = prompt();
    handlers.GENERATE_AFTER_COMBINE_PROMPTS({ prompt: '中间文本', dryRun: false }); assert.equal(prompt(), injected);
    handlers.CHAT_COMPLETION_PROMPT_READY({ chat: [{ role: 'user', content: '无关内部任务' }], dryRun: false }); assert.equal(prompt(), injected);
    const final = { chat: [{ role: 'user', content: '台词' }, { role: 'system', content: injected }], dryRun: false };
    handlers.CHAT_COMPLETION_PROMPT_READY(final); assert.equal(prompt(), ''); assert.equal(final.chat[1].content, injected); bridge.dispose();
});
test('设置事务被普通保存覆盖时拒绝，不能假装候选已持久化', async () => {
    const { host } = mockHost(); const live = story(), candidate = { ...clone(live), origin: 'new' };
    const transaction = host.save(candidate, host.identity(), { rollbackOnFailure: true });
    const regular = host.save(live, host.identity());
    await assert.rejects(transaction, /新变化/); await regular; assert.equal(host.load().origin, 'continue');
});
test('切回同轮较早的回复版本，重生成使用该回复保存的引导', () => {
    const { host, handlers, ctx, prompt } = mockHost(); const s = story(); s.mode = 'attach'; s.preference = '原版本';
    const bridge = new RoundBridge(host, () => s, () => {}, () => {});
    handlers.GENERATION_AFTER_COMMANDS('normal', {}, false); ctx.chat.push({ is_user: false, mes: '回复1', swipe_id: 0, swipe_info: [{ extra: {} }] }); handlers.MESSAGE_RECEIVED(1, 'normal');
    const originalExtra = clone(ctx.chat[1].extra); s.preference = '改写版本'; s.useEditedGuide = true;
    handlers.GENERATION_AFTER_COMMANDS('regenerate', {}, false); handlers.MESSAGE_RECEIVED(1, 'regenerate');
    assert(ctx.chat[1].extra['st-plot-guide'].guide.includes('改写版本'));
    ctx.chat[1].extra = originalExtra; handlers.GENERATION_AFTER_COMMANDS('regenerate', {}, false);
    assert(prompt().includes('原版本')); assert(!prompt().includes('改写版本')); bridge.dispose();
});
