import { KEY, VERSION } from './core.js';

const accessKey = `${KEY}-access`;
export function normalizeAccess(value = {}) {
    value = value && typeof value === 'object' ? value : {};
    return { visible: value.visible !== false, tuck: value.tuck !== false,
        side: value.side === 'left' ? 'left' : 'right',
        position: Number.isFinite(value.position) ? Math.max(0, Math.min(1, value.position)) : .4 };
}

// Interface preferences are independent of chat data and generation-setting drafts.
export function mountAccess(host, ui) {
    const ctx = () => host.getContext();
    let access = normalizeAccess(ctx().extensionSettings?.[accessKey]), timer;
    const wrapper = document.createElement('div'); wrapper.id = 'st-plot-access';
    wrapper.innerHTML = `<div class="inline-drawer">
      <button type="button" class="inline-drawer-toggle inline-drawer-header" aria-expanded="false" aria-controls="st-plot-access-content"><b>摩伊之线 · 剧情推进</b><span aria-hidden="true">⌄</span></button>
      <div id="st-plot-access-content" class="inline-drawer-content" hidden>
        <p>规划故事、手动推进阶段，为下一轮选择方向。</p>
        <button type="button" id="st-plot-settings-entry" class="menu_button menu_button_icon">打开摩伊之线 ↗</button>
        <label><input id="st-plot-dock-visible" type="checkbox">显示条形悬浮入口</label>
        <label><input id="st-plot-dock-tuck" type="checkbox">闲置时贴边收纳</label>
        <button type="button" id="st-plot-dock-reset" class="menu_button">重置悬浮位置</button>
        <p>拖动悬浮条可调整位置；隐藏后仍可从魔法棒打开。</p>
        <p>当前版本 <span>${VERSION}</span></p>
      </div></div>`;
    const q = s => wrapper.querySelector(s);
    function render() {
        q('#st-plot-dock-visible').checked = access.visible;
        q('#st-plot-dock-tuck').checked = access.tuck;
        q('#st-plot-dock-tuck').disabled = !access.visible;
        ui.setAccess(access);
    }
    function update(patch) {
        const previous = access, stored = ctx().extensionSettings[accessKey];
        access = normalizeAccess({ ...access, ...patch });
        try { ctx().extensionSettings[accessKey] = { ...access }; ctx().saveSettingsDebounced(); }
        catch {
            if (stored === undefined) delete ctx().extensionSettings[accessKey]; else ctx().extensionSettings[accessKey] = stored;
            access = previous; ui.toast('入口设置未能保存，请重试。');
        }
        render();
    }
    q('.inline-drawer-toggle').onclick = event => {
        event.stopPropagation();
        const content = q('#st-plot-access-content'), expanded = content.hidden;
        content.hidden = !expanded; content.style.display = expanded ? 'block' : 'none';
        event.currentTarget.setAttribute('aria-expanded', String(expanded));
    };
    q('#st-plot-settings-entry').onclick = () => ui.open(1);
    q('#st-plot-dock-visible').onchange = e => update({ visible: e.target.checked });
    q('#st-plot-dock-tuck').onchange = e => update({ tuck: e.target.checked });
    q('#st-plot-dock-reset').onclick = () => update({ side: 'right', position: .4 });
    const wand = document.createElement('div'); wand.id = 'st-plot-wand'; wand.tabIndex = 0; wand.setAttribute('role', 'button');
    wand.className = 'list-group-item flex-container flexGap5';
    wand.innerHTML = '<span class="extensionsMenuExtensionButton fa-solid fa-box" aria-hidden="true"></span><span>摩伊之线</span>';
    wand.onclick = event => {
        event.stopPropagation();
        // Let the host close its own menu before opening a modal, as other ST extensions do.
        if (globalThis.jQuery) globalThis.jQuery(document).trigger('click');
        else document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        clearTimeout(timer); timer = setTimeout(() => ui.open(1), 150);
    };
    wand.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); wand.click(); } };
    const fallback = document.createElement('button'); fallback.id = 'st-plot-fallback'; fallback.textContent = '摩伊之线 · 打开'; fallback.onclick = () => ui.open(1);
    function attach() {
        const settings = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings'), menu = document.querySelector('#extensionsMenu');
        if (settings && wrapper.parentNode !== settings) settings.append(wrapper);
        if (menu && wand.parentNode !== menu) menu.append(wand);
        if (!settings && !menu && !fallback.isConnected) document.body.append(fallback);
        if ((settings || menu) && fallback.isConnected) fallback.remove();
    }
    const off = host.on('APP_READY', attach);
    const observer = new MutationObserver(attach); observer.observe(document.body, { childList: true, subtree: true });
    attach(); ui.onAccessChange(update); render();
    return { dispose() { clearTimeout(timer); observer.disconnect(); off(); wrapper.remove(); wand.remove(); fallback.remove(); ui.onAccessChange(null); } };
}
