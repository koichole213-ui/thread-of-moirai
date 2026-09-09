// Host-backed settings; UI structure and interactions ported from the approved prototype.
import { VERSION, clone, uid, stateKey as pairKey } from './core.js';
import { followReferences, rememberEntries, presetChecked, extraCategory } from './references.js';
import { fetchModels } from './models.js';
import { createUpdater, mountUpdater } from './updates.js';
export function mountSettings(root, { host, getState, getSettings, commit, saveConnections, toast, baseURL }) {
  const q = s => root.querySelector(s);
  let refs = null, openEpoch = 0, cards = {}, books = {}, presets = {}, pendingLoads = 0, saving = false, materialDirty = false, connectionDirty = false;
  const stagedKeys = new Map();
  const failedKeySlots = new Set();
  const modelRequests = new Map();
  function cancelModels(slot) {
    modelRequests.get(slot)?.abort(); modelRequests.delete(slot);
    const button = q(`#ref-${slot}-test`); if (button) { button.disabled = false; button.textContent = '拉取模型列表 ↓'; }
    const select = q(`#ref-${slot}-model-select`); if (select) { select.hidden = true; select.replaceChildren(); }
  }
  function connectionStatus() { q('#ref-save-status').textContent = failedKeySlots.size ? '密钥未保存，请重新填写后重试。' : materialDirty ? '有未保存的调整\n关闭或取消会放弃参考资料修改' : '连接参数已保存'; }
  function autoSaveConnections() {
    try {
      saveConnections({ route: draft.route, secondaryEnabled: draft.secondaryEnabled, primary: apiValues('main'), secondary: apiValues('secondary'), apiPresets: clone(draft.apiPresets) });
      connectionDirty = false; connectionStatus();
      return true;
    } catch { connectionDirty = true; q('#ref-save-status').textContent = '有未保存的调整\n关闭或取消会放弃未保存部分'; toast('连接参数未能保存，请重试。'); return false; }
  }
  function flatten(settings) {
    const s = clone(settings), p = s.primary, b = s.secondary;
    return { ...s, card: 'current', origin: getState().origin, chatEnabled: getState().chatEnabled, chatCount: getState().chatCount,
      connection: p.name, protocol: p.protocol, model: p.model, stream: p.stream, apiEndpoint: p.endpoint, credentialId: p.credentialId,
      secondaryConnection: b.name, secondaryProtocol: b.protocol, secondaryModel: b.model, secondaryStream: b.stream, secondaryEndpoint: b.endpoint, secondaryCredentialId: b.credentialId };
  }
  function unflatten(d) {
    const s = clone(d); s.primary = apiValues('main'); s.secondary = apiValues('secondary');
    for (const key of ['card','origin','chatEnabled','chatCount','connection','protocol','model','stream','apiEndpoint','credentialId','secondaryConnection','secondaryProtocol','secondaryModel','secondaryStream','secondaryEndpoint','secondaryCredentialId']) delete s[key];
    if (s.userFollow) s.userText = '';
    return s;
  }
  let saved = flatten(getSettings());
  function effectivePreset() { return draft.preset === '@current' ? refs?.currentPreset || '' : draft.preset; }
  function presetRows() { return presets[effectivePreset()] || []; }
  function checkedPreset(id) { const e = refs?.presets[effectivePreset()]?.entries.find(x => x.id === id); return e ? presetChecked(draft, effectivePreset(), e) : false; }
  function categoryFor(id) { return extraCategory(refs.presets[effectivePreset()].entries.find(x => x.id === id)); }
  function rows(entries) { return entries.map(e => [e.uid, e.comment || e.key?.join('、') || `条目 ${e.uid}`, e.disable || e.enabled === false ? '已停用' : e.vectorized ? '链式 · 已启用' : e.constant ? '蓝灯 · 常驻' : '绿灯 · 关键词', e.content || '']); }
  function saveAvailability() { const button = q('#ref-save'); if (button) button.disabled = saving || pendingLoads > 0; }
  async function loadBook(name) {
    const epoch = openEpoch, currentDraft = draft; pendingLoads++; saveAvailability();
    try { const entries = await host.loadBook(name, refs, currentDraft); if (epoch !== openEpoch || currentDraft !== draft) throw new Error('设置已关闭'); books[name] = rows(entries); }
    finally { pendingLoads--; saveAvailability(); }
  }
  function prepareReferences() {
    cards = { current: { char: refs.name, user: refs.user, userText: refs.persona } };
    books = Object.fromEntries(refs.names.map(name => [name, rows(refs.books[name] || [])]));
    presets = Object.fromEntries(Object.entries(refs.presets).map(([name, p]) => [name, p.entries.map(e => [e.id, e.name, e.content])]));
    const select = q('#ref-preset'); select.replaceChildren();
    for (const [value, label] of [['@current', `跟随酒馆当前预设 · ${refs.currentPreset || '无'}`], ['', '不使用创作预设'], ...Object.keys(presets).map(x => [x, x])]) { const option = document.createElement('option'); option.value = value; option.textContent = label; select.append(option); }
  }
  let draft = clone(saved), lastTrigger = null, libraryScope = 'all', libraryPage = 0, entryLimit = 20;
  const booksPerPage = 12;
  const apiFields = slot => {
    const label = slot === 'main' ? '主要' : '副';
    return `<label class="ref-select-field">${label} API 预设<select id="ref-${slot}-api-preset"></select></label>
      <div class="ref-api-preset-actions"><button id="ref-${slot}-preset-update" class="text-button">保存当前预设</button><button id="ref-${slot}-preset-new" class="text-button">另存为新预设 ＋</button></div>
      <div id="ref-${slot}-preset-form" class="ref-api-name-form" hidden><label for="ref-${slot}-preset-name">新预设名称</label><input id="ref-${slot}-preset-name" maxlength="40" placeholder="例如：日常创作、快速改写"><div><button id="ref-${slot}-preset-cancel" class="text-button">取消</button><button id="ref-${slot}-preset-create" class="pill">添加预设</button></div></div>
      <p id="ref-${slot}-preset-status" class="ref-muted" role="status"></p>
      <details class="ref-details ref-api-fields"><summary>连接参数 <span id="ref-${slot}-model-summary"></span></summary>
        <label class="ref-select-field">${label} API 地址<input id="ref-${slot}-url" type="url" placeholder="https://…/v1"></label>
        <label class="ref-select-field">${label} API Key<input id="ref-${slot}-key" type="password" placeholder="自动保存到酒馆插件设置" autocomplete="off"></label><button id="ref-${slot}-key-clear" class="text-button">清除密钥</button>
        <div class="ref-field-pair"><label class="ref-select-field">${label} API 请求格式<select id="ref-${slot}-protocol"><option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic</option><option value="auto">自动识别</option></select></label><label class="ref-select-field">${label} API 模型<input id="ref-${slot}-model" placeholder="填写模型名称"></label></div>
        <select id="ref-${slot}-model-select" aria-label="${label} API 模型列表" hidden></select>
        <div class="ref-controls"><button id="ref-${slot}-test" class="text-button">拉取模型列表 ↓</button><label class="ref-switch"><input id="ref-${slot}-stream" type="checkbox" role="switch">流式显示</label></div>
        <p class="ref-inline-note">独立 API 需允许跨域访问。</p><details class="ref-details"><summary>连接与保存说明</summary><p class="ref-muted">连接参数和密钥自动保存到酒馆插件设置，刷新后保留；不写入聊天。留空保留已存密钥，清除请点“清除密钥”。拉取列表由浏览器直连服务；不支持列表的接口仍可手动填模型。</p></details><p id="ref-${slot}-api-status" class="ref-save-toast" role="status"></p>
      </details>`;
  };
  const dialog = document.createElement('dialog');
  dialog.id = 'reference-dialog'; dialog.setAttribute('aria-labelledby', 'reference-title');
  dialog.innerHTML = `
    <header class="ref-head"><div class="dialog-header"><div><h2 id="reference-title">参考与生成设置</h2></div><button id="ref-close" class="icon" aria-label="关闭设置">×</button></div></header>
    <nav class="ref-tabs" role="tablist" aria-label="参考与生成设置分类"><button id="ref-material-tab" role="tab" aria-selected="true" aria-controls="ref-material-panel">参考资料</button><button id="ref-model-tab" role="tab" aria-selected="false" aria-controls="ref-model-panel" tabindex="-1">模型与预设</button></nav>
    <div class="ref-scroll">
      <section id="ref-material-panel" role="tabpanel" aria-labelledby="ref-material-tab">
        <div class="ref-context"><span>当前角色</span><strong id="ref-current-character"></strong></div>
        <section class="ref-section"><div class="ref-section-title"><span>01</span><h3>User 人设</h3></div>
          <article class="ref-card"><div class="ref-card-top"><div class="ref-card-name"><label class="ref-switch"><input type="checkbox" id="ref-user-enabled" aria-label="将 User 人设用于生成"><span class="ref-avatar user" aria-hidden="true" id="ref-user-avatar">林</span></label><div><strong id="ref-user-name"></strong><small id="ref-user-source">User · 当前用户人设</small></div></div><label class="ref-switch"><input type="checkbox" role="switch" id="ref-user-follow">自动跟随</label></div><details class="ref-details"><summary>查看与调整人设</summary><textarea id="ref-user-text" rows="4" aria-label="User 人设内容"></textarea><p class="ref-muted" id="ref-user-note"></p></details></article>
          <p id="ref-follow-note" class="ref-context-note" role="status"></p>
        </section>
        <section class="ref-section"><div class="ref-section-title"><span>02</span><h3>世界书</h3><span class="ref-counter" id="ref-book-count"></span></div>
          <label class="ref-switch"><input type="checkbox" role="switch" id="ref-book-follow">跟随角色卡绑定的世界书</label>
          <details id="ref-library" class="ref-library"><summary><span><strong id="ref-selected-book-title">已选 2 本世界书</strong><small id="ref-selected-book-names"></small></span><span class="ref-library-action">选择世界书 <span aria-hidden="true">⌄</span></span></summary>
            <div class="ref-library-body"><label class="sr-only" for="ref-library-search">搜索世界书名称</label><input id="ref-library-search" class="ref-library-search" type="search" placeholder="搜索世界书名称…">
              <div class="ref-library-scopes" role="group" aria-label="筛选世界书"><button id="ref-scope-all" aria-pressed="true">全部</button><button id="ref-scope-follow" aria-pressed="false">当前角色</button><button id="ref-scope-selected" aria-pressed="false">已选</button></div>
              <div id="ref-books" class="ref-book-list" role="group" aria-label="选择世界书"></div>
              <div class="ref-library-pager"><span id="ref-library-count" role="status"></span><button id="ref-library-prev" class="text-button" aria-label="世界书上一页">←</button><span id="ref-library-page"></span><button id="ref-library-next" class="text-button" aria-label="世界书下一页">→</button></div>
            </div>
          </details>
          <p class="ref-muted">带「随卡」标记的书会跟着角色换；额外手选的书会保留。</p>
          <div class="ref-controls"><label for="ref-read-mode" class="ref-muted">条目范围</label><select id="ref-read-mode"><option value="all">全部条目</option><option value="enabled">酒馆开启条目（含链式）</option><option value="lights">蓝灯与绿灯条目</option></select></div>
          <div class="ref-search"><input id="ref-book-search" type="search" placeholder="搜索条目或书名…" aria-label="搜索世界书条目"><button id="ref-select-visible" class="text-button">全选结果</button><button id="ref-clear-visible" class="text-button">清空结果</button></div>
          <div id="ref-entries" class="ref-entry-list"></div><button id="ref-more-entries" class="ref-more-entries text-button" hidden>继续查看条目</button><p class="ref-muted">按当前勾选直接读取，不判断关键词触发。</p>
        </section>
        <section class="ref-section"><div class="ref-section-title"><span>03</span><h3>聊天前文</h3></div>
          <div class="ref-controls"><label class="ref-switch"><input type="checkbox" role="switch" id="ref-chat-enabled">参考最近的聊天</label><select id="ref-origin" aria-label="故事起点"><option value="continue">接着当前聊天</option><option value="new">规划一个新故事</option></select></div>
          <div id="ref-chat-range" class="ref-number-row"><label for="ref-chat-count">读取最近</label><input id="ref-chat-count" type="number" min="0" max="1000" value="20"><span>条消息</span></div>
          <p class="ref-muted" id="ref-chat-note"></p><details class="ref-details"><summary>查看本次参考前文</summary><p class="ref-muted" id="ref-chat-preview"></p></details>
        </section>
      </section>
      <section id="ref-model-panel" role="tabpanel" aria-labelledby="ref-model-tab" hidden>
        <section class="ref-section"><div class="ref-section-title"><span>01</span><h3>用哪个模型创作</h3></div>
          <div class="ref-route" role="group" aria-label="选择 API"><button id="ref-route-main" aria-pressed="true"><strong>酒馆主 API</strong><small>沿用酒馆当前连接<br>无需重复填写</small></button><button id="ref-route-custom" aria-pressed="false"><strong>独立 API</strong><small>为剧情工具单独配置<br>和聊天模型分开</small></button></div>
          <div id="ref-main-fields"><div class="ref-main-model"><span class="ref-status-dot" aria-hidden="true"></span><div><strong>跟随酒馆当前连接</strong><p>使用酒馆当前聊天补全连接</p></div></div></div>
          <div id="ref-custom-fields" hidden>${apiFields('main')}</div>
          <article class="ref-secondary-api"><div class="ref-secondary-head"><div><h4>副 API</h4><p>给换一批、修改选项单独选个模型</p></div><label class="ref-switch"><input id="ref-secondary-enabled" type="checkbox" role="switch" aria-label="启用副 API">启用</label></div>
            <div id="ref-secondary-fields" hidden>${apiFields('secondary')}<p class="ref-inline-note">请求失败时不会自动切换线路。</p></div>
          </article><div id="ref-api-routing" class="ref-api-routing" aria-live="polite"></div>
        </section>
        <section class="ref-section"><div class="ref-section-title"><span>02</span><h3>创作预设</h3><span class="ref-counter" id="ref-preset-count"></span></div>
          <label class="ref-select-field">选择预设<select id="ref-preset"><option value="">不使用创作预设</option></select></label>
          <label class="ref-switch"><input type="checkbox" id="ref-filter-extras">过滤摘要、待办、小剧场专用条目</label><p class="ref-filter-note">默认排除专用条目；混合规则请手动检查。</p><div id="ref-preset-entries" class="ref-entry-list"></div>
          <p class="ref-inline-note">此处调整不会修改酒馆原预设。</p>
        </section>
        <section class="ref-section"><div class="ref-section-title"><span>03</span><h3>本次会带上什么</h3></div><div id="ref-request-summary" class="ref-review"></div></section>
      </section>
    </div>
    <footer class="ref-footer"><div class="ref-update-row"><span>摩伊之线 ${VERSION}</span><button id="ref-check-update" class="text-button">↻ 检查更新</button><button id="ref-apply-update" class="text-button" hidden>更新</button><button id="ref-reload-update" class="text-button" hidden>刷新生效</button><span id="ref-update-status" role="status"></span></div><p class="ref-save-status"><span id="ref-save-status" role="status"></span></p><button id="ref-cancel" class="text-button">取消</button><button id="ref-save" class="primary">保存设置 <span>✓</span></button></footer>`;
  root.append(dialog);
  const updateUI = mountUpdater(root, { updater: createUpdater(host, baseURL), canReload: () => !materialDirty && !connectionDirty && !failedKeySlots.size && !saving && !pendingLoads });
  const shortcut = document.createElement('button');
  shortcut.id = 'show-references'; shortcut.textContent = '参考与生成'; shortcut.setAttribute('aria-haspopup', 'dialog');

  const element = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; };
  const stateKey = pairKey;
  const entriesFor = () => draft.selectedBooks.flatMap(book => (books[book] || []).map(entry => ({ book, entry, key: stateKey(book, entry[0]) })));
  const inRange = ({ entry }) => draft.readMode === 'all' || (entry[2] !== '已停用' && (draft.readMode !== 'lights' || !entry[2].startsWith('链式')));
  const isChecked = row => draft.entryStates[row.key] ?? row.entry[2] !== '已停用';
  const visibleEntries = () => {
    const search = q('#ref-book-search').value.trim().toLowerCase();
    return entriesFor().filter(row => inRange(row) && `${row.book} ${row.entry[1]}`.toLowerCase().includes(search));
  };
  function updateSummary() {
    const count = entriesFor().filter(row => inRange(row) && isChecked(row)).length;
    q('#ref-book-count').textContent = `${draft.selectedBooks.length} 本 · ${count} 条参与`;
    const presetCount = presetRows().filter(([id]) => checkedPreset(id)).length;
    q('#ref-preset-count').textContent = `${presetCount} 条参与`;
    q('#ref-request-summary').textContent = [
      `User 人设：${draft.userEnabled ? (draft.userFollow ? cards[draft.card].user : '自填 User') : '不读取'}`,
      `世界书：${draft.selectedBooks.length} 本，${count} 条（按当前范围筛选）`,
      `聊天前文：${draft.chatEnabled && draft.chatCount ? `最近 ${draft.chatCount} 条` : '不读取'}`,
      `模型：${draft.route === 'main' ? '酒馆主 API · 跟随当前连接' : `独立 API · ${draft.model}`}`,
      `换一批／修改选项：${draft.secondaryEnabled ? `副 API · ${draft.secondaryModel}` : '沿用主配置'}`,
      `创作预设：${draft.preset || '不使用'}${draft.preset ? ` · ${presetCount} 条` : ''}`,
    ].join('\n');
  }
  function renderPeople() {
    const card = cards[draft.card];
    for (const kind of ['user']) {
      const follow = draft[`${kind}Follow`];
      q(`#ref-${kind}-name`).textContent = follow ? card[kind] : `自填 ${kind === 'char' ? 'Char' : 'User'} 人设`;
      q(`#ref-${kind}-avatar`).textContent = follow ? card[kind][0] : '自';
      q(`#ref-${kind}-source`).textContent = follow ? (kind === 'char' ? 'Char · 当前角色卡' : 'User · 当前用户人设') : '保留自填内容，不随切卡替换';
      q(`#ref-${kind}-enabled`).checked = draft[`${kind}Enabled`];
      q(`#ref-${kind}-follow`).checked = follow;
      q(`#ref-${kind}-text`).value = draft[`${kind}Text`];
      q(`#ref-${kind}-text`).readOnly = follow;
      q(`#ref-${kind}-note`).textContent = follow ? '正在自动跟随。关闭跟随后可以自填，不改原人设。' : '这里的文字只用于剧情工具；重新开启跟随会换回当前人设。';
    }
  }
  function renderBooks() {
    const box = q('#ref-books'); box.replaceChildren();
    const search = q('#ref-library-search').value.trim().toLowerCase();
    const allBooks = Object.keys(books);
    const filtered = allBooks.filter(book => book.toLowerCase().includes(search) && (libraryScope === 'all' || (libraryScope === 'selected' ? draft.selectedBooks.includes(book) : refs.boundBooks.includes(book))));
    const pages = Math.max(1, Math.ceil(filtered.length / booksPerPage));
    libraryPage = Math.max(0, Math.min(libraryPage, pages - 1));
    q('#ref-selected-book-title').textContent = `已选 ${draft.selectedBooks.length} 本世界书`;
    q('#ref-selected-book-names').textContent = draft.selectedBooks.length ? `${draft.selectedBooks.slice(0, 2).join('、')}${draft.selectedBooks.length > 2 ? ` 等 ${draft.selectedBooks.length} 本` : ''}` : '从书库中选择，也可以暂时不带世界书';
    q('#ref-scope-all').textContent = `全部 ${allBooks.length}`;
    q('#ref-scope-follow').textContent = `当前角色 ${refs.boundBooks.length}`;
    q('#ref-scope-selected').textContent = `已选 ${draft.selectedBooks.length}`;
    for (const scope of ['all', 'follow', 'selected']) q(`#ref-scope-${scope}`).setAttribute('aria-pressed', String(libraryScope === scope));
    for (const book of filtered.slice(libraryPage * booksPerPage, (libraryPage + 1) * booksPerPage)) {
      const label = element('label', 'ref-book-row');
      const input = element('input'); input.type = 'checkbox'; input.checked = draft.selectedBooks.includes(book); input.setAttribute('aria-label', book);
      const copy = element('span', 'ref-book-copy');
      copy.append(element('strong', '', book), element('small', '', Object.hasOwn(refs.books, book) ? `${books[book].length} 条设定` : '选择后读取条目'));
      label.append(input, copy);
      if (draft.bookFollow && refs.boundBooks.includes(book)) label.append(element('small', 'ref-book-badge', '随卡'));
      input.onchange = async () => {
        if (input.checked) { try { await loadBook(book); } catch { input.checked = false; toast("世界书读取失败，请重试。"); return; } }
        draft.selectedBooks = input.checked ? [...draft.selectedBooks, book] : draft.selectedBooks.filter(b => b !== book);
        const scroll = box.scrollTop;
        renderBooks(); box.scrollTop = scroll; dirty();
        // Preserve keyboard focus if the row remains in the current filtered page.
        [...box.querySelectorAll('input')].find(el => el.getAttribute('aria-label') === book)?.focus({ preventScroll: true });
      };
      box.append(label);
    }
    if (!filtered.length) box.append(element('p', 'ref-library-empty', search ? '没有找到这本书，试试更短的关键词。' : '还没有选书，可以切到「全部」添加。'));
    q('#ref-library-count').textContent = `${filtered.length} 本${search ? '匹配' : '可查看'}`;
    q('#ref-library-page').textContent = `${libraryPage + 1} / ${pages}`;
    q('#ref-library-prev').disabled = libraryPage === 0;
    q('#ref-library-next').disabled = libraryPage === pages - 1;
    renderEntries();
  }
  function renderEntries() {
    const box = q('#ref-entries'); box.replaceChildren();
    const rows = visibleEntries();
    for (const row of rows.slice(0, entryLimit)) {
      const label = element('article', 'ref-material'), input = element('input');
      input.type = 'checkbox'; input.checked = isChecked(row); input.dataset.entryKey = row.key; input.setAttribute('aria-label', row.entry[1]);
      input.onchange = () => { draft.entryStates[row.key] = input.checked; dirty(); };
      const details = element('details'), summary = element('summary'), text = element('span', '', row.entry[1]);
      text.append(element('small', '', `${row.book} · ${row.entry[2]}`)); summary.append(text);
      details.append(summary, element('p', '', row.entry[3])); label.append(input, details); box.append(label);
    }
    if (!box.children.length) box.append(element('p', 'ref-muted', draft.selectedBooks.length ? '没有匹配的条目，换个关键词或调整条目范围。' : '还没有选择世界书。可以只使用人设，也可以在上面加选。'));
    q('#ref-more-entries').hidden = rows.length <= entryLimit;
    q('#ref-more-entries').textContent = `已显示 ${Math.min(entryLimit, rows.length)} / ${rows.length} 条 · 继续查看`;
    updateSummary();
  }
  function renderPreset() {
    const box = q('#ref-preset-entries'); box.replaceChildren();
    for (const [id, name, content] of presetRows()) {
      const key = stateKey(effectivePreset(), id), row = element('article', 'ref-material'), input = element('input');
      input.type = 'checkbox'; input.checked = checkedPreset(id); input.setAttribute('aria-label', name);
      input.onchange = () => { draft.presetStates[key] = input.checked; dirty(); };
      const details = element('details'), summary = element('summary', '', name + (categoryFor(id) ? ` · ${checkedPreset(id) ? '参与' : '已排除'}${categoryFor(id)}` : '')), textarea = element('textarea');
      textarea.rows = 3; textarea.value = draft.presetTexts[key] ?? content; textarea.setAttribute('aria-label', `调整${name}`);
      textarea.oninput = () => { draft.presetTexts[key] = textarea.value; dirty(); };
      details.append(summary, textarea); row.append(input, details); box.append(row);
    }
    if (!draft.preset) box.append(element('p', 'ref-muted', '仅使用故事偏好、已选参考资料和大纲结构要求。'));
    updateSummary();
  }
  function renderRoute() {
    const custom = draft.route === 'custom';
    q('#ref-route-main').setAttribute('aria-pressed', String(!custom)); q('#ref-route-custom').setAttribute('aria-pressed', String(custom));
    q('#ref-main-fields').hidden = custom; q('#ref-custom-fields').hidden = !custom;
    q('#ref-secondary-enabled').checked = draft.secondaryEnabled;
    q('#ref-secondary-fields').hidden = !draft.secondaryEnabled;
    renderApiSlot('main'); renderApiSlot('secondary'); updateApiRouting();
  }
  function apiValues(slot) {
    return slot === 'main' ? { name: draft.connection, protocol: draft.protocol, model: draft.model, stream: draft.stream, endpoint: draft.apiEndpoint, credentialId: draft.credentialId }
      : { name: draft.secondaryConnection, protocol: draft.secondaryProtocol, model: draft.secondaryModel, stream: draft.secondaryStream, endpoint: draft.secondaryEndpoint, credentialId: draft.secondaryCredentialId };
  }
  function setApiValues(slot, profile) {
    if (slot === 'main') Object.assign(draft, { connection: profile.name, protocol: profile.protocol, model: profile.model, stream: profile.stream, apiEndpoint: profile.endpoint, credentialId: profile.credentialId });
    else Object.assign(draft, { secondaryConnection: profile.name, secondaryProtocol: profile.protocol, secondaryModel: profile.model, secondaryStream: profile.stream, secondaryEndpoint: profile.endpoint, secondaryCredentialId: profile.credentialId });
  }
  function renderApiSlot(slot) {
    const values = apiValues(slot), select = q(`#ref-${slot}-api-preset`); select.replaceChildren();
    draft.apiPresets.forEach(profile => { const option = element('option', '', profile.name); option.value = profile.name; select.append(option); });
    select.value = values.name; q(`#ref-${slot}-protocol`).value = values.protocol; q(`#ref-${slot}-model`).value = values.model; q(`#ref-${slot}-stream`).checked = values.stream;
    q(`#ref-${slot}-url`).value = values.endpoint; q(`#ref-${slot}-key`).value = ''; q(`#ref-${slot}-key`).placeholder = host.credentials.has(values.credentialId) ? '已保存密钥；留空保留' : '自动保存到酒馆插件设置';
    q(`#ref-${slot}-model-summary`).textContent = values.model;
  }
  function updateApiRouting() {
    const main = draft.route === 'main' ? '酒馆主 API' : draft.model;
    q('#ref-api-routing').replaceChildren();
    for (const [action, model] of [['生成大纲／首次候选', main], ['换一批／修改选项', draft.secondaryEnabled ? draft.secondaryModel : main]]) {
      const row = element('div'); row.append(element('span', '', action), element('strong', '', model)); q('#ref-api-routing').append(row);
    }
  }
  function saveApiPreset(slot, newName = null) {
    const name = newName === null ? apiValues(slot).name : newName.trim();
    const status = q(`#ref-${slot}-preset-status`);
    if (!name || name.length > 40) { status.textContent = '请填写 1–40 字的名称。'; return; }
    if (newName !== null && draft.apiPresets.some(p => p.name === name)) { status.textContent = '已有同名预设，请换个名称；更新原预设可点「保存当前预设」。'; return; }
    const profile = { ...apiValues(slot), name };
    const index = draft.apiPresets.findIndex(p => p.name === name);
    if (index < 0) draft.apiPresets.push(profile); else draft.apiPresets[index] = profile;
    stagedKeys.clear(); // Further edits must detach from the newly saved preset.
    setApiValues(slot, profile);
    renderApiSlot('main'); renderApiSlot('secondary');
    q(`#ref-${slot}-preset-form`).hidden = true;
    dirty(false); updateApiRouting();
    status.textContent = autoSaveConnections() ? `「${name}」已保存。` : `「${name}」尚未保存，请重试。`;
  }
  function renderChat() {
    q('#ref-chat-enabled').checked = draft.chatEnabled; q('#ref-chat-count').value = draft.chatCount; q('#ref-chat-count').disabled = !draft.chatEnabled;
    q('#ref-chat-range').classList.toggle('is-disabled', !draft.chatEnabled); q('#ref-origin').value = draft.origin;
    q('#ref-chat-note').textContent = draft.chatEnabled && draft.chatCount > 0 ? '按此范围读取最近的聊天。新故事也可以手动开启前文参考。' : '本次不带聊天前文。规划新故事不会清空原聊天。';
    q('#ref-chat-preview').textContent = draft.chatEnabled && draft.chatCount > 0 ? refs.chat.slice(-draft.chatCount).map(m => `${m.role === 'user' ? refs.user : refs.name}：${m.content}`).join('\n\n') : '本次不带聊天前文。';
  }
  function dirty(material = true) {
    materialDirty ||= material;
    if (materialDirty) q('#ref-save-status').textContent = '有未保存的调整\n关闭或取消会放弃参考资料修改';
    updateSummary();
  }
  function selectTab(index) {
    ['material', 'model'].forEach((name, n) => {
      const button = q(`#ref-${name}-tab`); button.setAttribute('aria-selected', String(n === index)); button.tabIndex = n === index ? 0 : -1;
      q(`#ref-${name}-panel`).hidden = n !== index;
    });
    q('.ref-scroll').scrollTop = 0; updateSummary();
  }
  async function openSettings(event) {
    const epoch = ++openEpoch; stagedKeys.clear();
    try {
      const config = clone(getSettings()); refs = await host.referenceHeader(config);
      await Promise.allSettled(config.selectedBooks.map(name => host.loadBook(name, refs, config)));
      if (epoch !== openEpoch || refs.identity !== host.identity()) return; prepareReferences();
    } catch { toast('参考资料未读取完整，请检查当前聊天。'); return; }
    lastTrigger = event?.currentTarget || q('#show-references'); saved = flatten(getSettings()); draft = clone(saved);
    followReferences(draft, refs.boundBooks); for (const [name, entries] of Object.entries(refs.books)) rememberEntries(draft, name, entries);
    if (draft.userFollow) draft.userText = refs.persona;
    draft.origin = q('#origin').selectedIndex === 1 ? 'new' : 'continue';
    q('#ref-current-character').textContent = refs.name; q('#ref-filter-extras').checked = draft.filterExtras; q('#ref-book-follow').checked = draft.bookFollow; q('#ref-read-mode').value = draft.readMode;
    q('#ref-book-search').value = ''; q('#ref-preset').value = draft.preset;
    for (const slot of ['main', 'secondary']) { q(`#ref-${slot}-api-status`).textContent = ''; q(`#ref-${slot}-preset-status`).textContent = ''; q(`#ref-${slot}-preset-form`).hidden = true; }
    q('#ref-library-search').value = ''; libraryScope = 'all'; libraryPage = 0; entryLimit = 20;
    q('#ref-follow-note').textContent = refs.catalogWarning ? '完整世界书目录暂未读取成功；可关闭设置后重试。' : '';
    const failed = draft.selectedBooks.filter(name => !Object.hasOwn(refs.books, name));
    if (failed.length) q('#ref-follow-note').textContent = `有 ${failed.length} 本所选世界书未能读取，请在书库取消选择或关闭后重试。`;
    materialDirty = connectionDirty = false; q('#ref-save-status').textContent = '';
    dialog.querySelectorAll('details').forEach(d => { d.open = false; });
    renderPeople(); renderBooks(); renderPreset(); renderRoute(); renderChat(); selectTab(0);
    if (!dialog.open) dialog.showModal();
    q('.ref-scroll').scrollTop = 0;
  }
  function closeSettings() { if (!saving) { materialDirty = connectionDirty = false; dialog.close(); } }
  dialog.addEventListener('cancel', e => { if (saving) e.preventDefault(); });
  dialog.addEventListener('close', () => { lastTrigger?.focus({ preventScroll: true }); });
  q('#ref-close').onclick = closeSettings; q('#ref-cancel').onclick = closeSettings;
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeSettings();
  });
  q('#open-generation-settings').onclick = openSettings; shortcut.onclick = openSettings;
  ['material', 'model'].forEach((name, i) => {
    const button = q(`#ref-${name}-tab`); button.onclick = () => selectTab(i);
    button.onkeydown = e => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault(); const next = e.key === 'Home' ? 0 : e.key === 'End' ? 1 : 1 - i; selectTab(next); q(next ? '#ref-model-tab' : '#ref-material-tab').focus();
    };
  });
  for (const kind of ['user']) {
    q(`#ref-${kind}-enabled`).onchange = e => { draft[`${kind}Enabled`] = e.target.checked; dirty(); };
    q(`#ref-${kind}-follow`).onchange = e => { draft[`${kind}Follow`] = e.target.checked; if (e.target.checked) draft[`${kind}Text`] = cards[draft.card][`${kind}Text`]; renderPeople(); dirty(); };
    q(`#ref-${kind}-text`).oninput = e => { draft[`${kind}Text`] = e.target.value; dirty(); };
  }
  q('#ref-book-follow').onchange = async e => {
    draft.bookFollow = e.target.checked;
    if (draft.bookFollow) { followReferences(draft, refs.boundBooks, true); try { await Promise.all(draft.selectedBooks.map(loadBook)); } catch { toast('部分世界书未读取成功，请重试。'); } }
    renderBooks(); dirty();
  };
  q('#ref-library-search').oninput = () => { libraryPage = 0; renderBooks(); q('#ref-books').scrollTop = 0; };
  for (const scope of ['all', 'follow', 'selected']) q(`#ref-scope-${scope}`).onclick = () => { libraryScope = scope; libraryPage = 0; renderBooks(); q('#ref-books').scrollTop = 0; };
  for (const [id, direction] of [['prev', -1], ['next', 1]]) q(`#ref-library-${id}`).onclick = () => { libraryPage += direction; renderBooks(); q('#ref-books').scrollTop = 0; };
  q('#ref-more-entries').onclick = () => { entryLimit += 20; renderEntries(); };
  q('#ref-book-search').oninput = () => { entryLimit = 20; renderEntries(); };
  q('#ref-read-mode').onchange = e => { draft.readMode = e.target.value; renderEntries(); dirty(); };
  q('#ref-select-visible').onclick = () => { visibleEntries().forEach(row => { draft.entryStates[row.key] = true; }); renderEntries(); dirty(); };
  q('#ref-clear-visible').onclick = () => { visibleEntries().forEach(row => { draft.entryStates[row.key] = false; }); renderEntries(); dirty(); };
  q('#ref-chat-enabled').onchange = e => { draft.chatEnabled = e.target.checked; renderChat(); dirty(); };
  q('#ref-chat-count').onchange = e => { const n = Number(e.target.value); draft.chatCount = Number.isFinite(n) ? Math.max(0, Math.min(1000, Math.round(n))) : 20; renderChat(); dirty(); };
  q('#ref-origin').onchange = e => { draft.origin = e.target.value; draft.chatEnabled = draft.origin === 'continue'; renderChat(); dirty(); };
  for (const route of ['main', 'custom']) q(`#ref-route-${route}`).onclick = () => { draft.route = route; renderRoute(); dirty(false); autoSaveConnections(); };
  q('#ref-secondary-enabled').onchange = e => { draft.secondaryEnabled = e.target.checked; renderRoute(); dirty(false); autoSaveConnections(); };
  for (const slot of ['main', 'secondary']) {
    q(`#ref-${slot}-api-preset`).onchange = e => {
      const profile = draft.apiPresets.find(p => p.name === e.target.value);
      cancelModels(slot); stagedKeys.delete(slot);
      if (profile) setApiValues(slot, profile);
      renderApiSlot(slot); q(`#ref-${slot}-preset-status`).textContent = '已载入预设；另一组连接保持不变。'; q(`#ref-${slot}-api-status`).textContent = ''; updateApiRouting(); dirty(false); autoSaveConnections();
    };
    for (const field of ['protocol', 'model', 'stream', 'url']) q(`#ref-${slot}-${field}`)[['url', 'model'].includes(field) ? 'oninput' : 'onchange'] = e => {
      if (field === 'url' || field === 'protocol') cancelModels(slot);
      const values = apiValues(slot); values[field === 'url' ? 'endpoint' : field] = field === 'stream' ? e.target.checked : e.target.value; setApiValues(slot, values);
      q(`#ref-${slot}-model-summary`).textContent = values.model; q(`#ref-${slot}-preset-status`).textContent = '当前参数已调整；可以保存到原预设，也可以另存一份。'; updateApiRouting(); dirty(false); autoSaveConnections();
    };
    q(`#ref-${slot}-preset-update`).onclick = () => saveApiPreset(slot);
    q(`#ref-${slot}-preset-new`).onclick = () => { q(`#ref-${slot}-preset-form`).hidden = false; q(`#ref-${slot}-preset-name`).value = ''; q(`#ref-${slot}-preset-name`).focus(); };
    q(`#ref-${slot}-preset-cancel`).onclick = () => { q(`#ref-${slot}-preset-form`).hidden = true; q(`#ref-${slot}-preset-new`).focus(); };
    q(`#ref-${slot}-preset-create`).onclick = () => saveApiPreset(slot, q(`#ref-${slot}-preset-name`).value);
    q(`#ref-${slot}-preset-name`).onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); saveApiPreset(slot, e.target.value); } };
    q(`#ref-${slot}-key`).oninput = e => {
      cancelModels(slot); if (!e.target.value) return;
      const values = apiValues(slot);
      // Detach from a shared preset once per editing session, not once per keystroke.
      if (!stagedKeys.has(slot)) stagedKeys.set(slot, uid());
      values.credentialId = stagedKeys.get(slot);
      try { host.saveCredential(values.credentialId, e.target.value.trim()); failedKeySlots.delete(slot); setApiValues(slot, values); autoSaveConnections(); }
      catch { failedKeySlots.add(slot); connectionDirty = true; q('#ref-save-status').textContent = '密钥未保存，请重新填写后重试。'; toast('密钥未能保存，请重试。'); }
    };
    q(`#ref-${slot}-key-clear`).onclick = () => {
      cancelModels(slot);
      const previous = apiValues(slot); setApiValues(slot, { ...previous, credentialId: uid() });
      if (autoSaveConnections()) { failedKeySlots.delete(slot); connectionStatus(); stagedKeys.delete(slot); q(`#ref-${slot}-key`).value = ''; renderApiSlot(slot); toast('已清除当前连接密钥；已保存的独立预设保持不变。'); }
      else setApiValues(slot, previous);
    };
    q(`#ref-${slot}-model-select`).onchange = e => {
      if (!e.target.value) return;
      q(`#ref-${slot}-model`).value = e.target.value; q(`#ref-${slot}-model`).dispatchEvent(new Event('input', { bubbles: true }));
    };
    q(`#ref-${slot}-test`).onclick = async () => {
      cancelModels(slot); const controller = new AbortController(), epoch = openEpoch;
      modelRequests.set(slot, controller); const button = q(`#ref-${slot}-test`), status = q(`#ref-${slot}-api-status`);
      button.disabled = true; button.textContent = '正在拉取…'; status.textContent = '';
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const profile = apiValues(slot), models = await fetchModels(profile, host.credentials.get(profile.credentialId) || '', { signal: controller.signal });
        if (epoch !== openEpoch || controller.signal.aborted || modelRequests.get(slot) !== controller) return;
        const select = q(`#ref-${slot}-model-select`); select.replaceChildren(element('option', '', '选择模型…'));
        select.firstChild.value = '';
        for (const model of models) { const option = element('option', '', model); option.value = model; select.append(option); }
        select.value = models.includes(apiValues(slot).model) ? apiValues(slot).model : ''; select.hidden = false;
        status.textContent = `找到 ${models.length} 个模型。`;
      } catch (error) {
        if (epoch === openEpoch && modelRequests.get(slot) === controller) status.textContent = controller.signal.aborted ? '读取超时，请重试。' : /^(请先|API 地址|Anthropic|模型列表|接口未返回)/.test(error.message) ? error.message : '拉取失败，请检查连接或跨域支持；仍可手动填写模型。';
      } finally { clearTimeout(timer); if (modelRequests.get(slot) === controller) { modelRequests.delete(slot); button.disabled = false; button.textContent = '拉取模型列表 ↓'; } }
    };
  }
  q('#ref-preset').onchange = e => { draft.preset = e.target.value; renderPreset(); dirty(); };
  function savedSummary() {
    q('#settings-summary').textContent = [saved.userEnabled ? 'User 人设' : '', `世界书 ${saved.selectedBooks.length} 本`, saved.bookFollow ? '随角色卡切换' : '', saved.route === 'main' ? '酒馆主 API' : '独立 API'].filter(Boolean).join(' · ');
  }
  q('#ref-filter-extras').onchange = e => { draft.filterExtras = e.target.checked; renderPreset(); dirty(); };
  q('#ref-save').onclick = async () => {
    if (saving || pendingLoads) return;
    if (failedKeySlots.size) { toast('密钥未保存，请重新填写或清除后再保存设置。'); return; }
    if (!refs || refs.identity !== host.identity()) { toast('聊天已切换，请重新打开设置。'); closeSettings(); return; }
    const snapshot = clone(draft), config = unflatten(snapshot), epoch = openEpoch;
    saving = true; saveAvailability(); q('.ref-scroll').inert = true; q('#ref-cancel').disabled = true; q('#ref-close').disabled = true;
    try {
      await commit(config, { origin: snapshot.origin, chatEnabled: snapshot.chatEnabled, chatCount: snapshot.chatCount });
      if (epoch !== openEpoch || refs.identity !== host.identity()) return;
      saved = snapshot; savedSummary(); saving = false; closeSettings(); toast('设置已保存');
    } catch { toast('设置未能保存，本次草稿仍保留，请重试。'); }
    finally { saving = false; const scroll = q('.ref-scroll'); if (scroll) scroll.inert = false; saveAvailability(); for (const id of ['ref-cancel', 'ref-close']) { const button = q(`#${id}`); if (button) button.disabled = false; } }
  };
  q('#origin').addEventListener('change', () => { getState().origin = q('#origin').selectedIndex === 1 ? 'new' : 'continue'; getState().chatEnabled = getState().origin === 'continue'; });
  function refresh() { openEpoch++; if (dialog.open) dialog.close(); saved = flatten(getSettings()); savedSummary(); }
  dialog.addEventListener('close', () => { openEpoch++; failedKeySlots.clear(); stagedKeys.clear(); for (const slot of ['main', 'secondary']) { cancelModels(slot); const input = q(`#ref-${slot}-key`); if (input) input.value = ''; } });
  savedSummary();
  return { open: openSettings, refresh, dispose: () => { updateUI.dispose(); openEpoch++; for (const slot of ['main', 'secondary']) cancelModels(slot); dialog.remove(); stagedKeys.clear(); } };
}
