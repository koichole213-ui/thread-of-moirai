import { normalizeAccess } from './access.js';

export function mountDock(root, { isOpen, save }) {
    const rail = root.querySelector('.dock-rail'), container = root.querySelector('#story-dock');
    const handle = document.createElement('button'); handle.type = 'button'; handle.id = 'dock-drag';
    handle.textContent = '⠿'; handle.setAttribute('aria-label', '拖动悬浮入口；方向键调整位置');
    const reveal = document.createElement('button'); reveal.type = 'button'; reveal.id = 'dock-reveal';
    reveal.textContent = '剧情'; reveal.setAttribute('aria-label', '展开悬浮入口');
    rail.prepend(handle, reveal);
    let access = normalizeAccess(), timer, gesture = null, suppressClick = false, available = true;
    const clear = () => { clearTimeout(timer); timer = null; };
    function place() {
        container.dataset.side = access.side;
        const height = rail.offsetHeight || 210;
        rail.style.top = `${8 + access.position * Math.max(0, window.innerHeight - height - 16)}px`;
    }
    function schedule() {
        clear();
        if (!access.tuck || !access.visible || !available) return;
        timer = setTimeout(() => {
            if (gesture || isOpen() || rail.matches(':hover') || rail.querySelector(':focus-visible')) return;
            rail.dataset.tucked = 'true'; place();
        }, 2500);
    }
    function expand() { clear(); rail.dataset.tucked = 'false'; place(); }
    function sync(next = access, enabled = available) {
        access = normalizeAccess(next); available = enabled;
        container.hidden = !access.visible || !available;
        expand(); schedule();
    }
    function down(e) {
        if (!e.isPrimary || e.button !== 0 || e.target === reveal) return;
        suppressClick = false; clear();
        gesture = { id: e.pointerId, x: e.clientX, y: e.clientY, top: rail.getBoundingClientRect().top, moved: false };
    }
    function move(e) {
        if (!gesture || gesture.id !== e.pointerId) return;
        if (!gesture.moved && Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) < 7) return;
        if (!gesture.moved) { gesture.moved = true; rail.setPointerCapture(e.pointerId); }
        e.preventDefault();
        const range = Math.max(1, window.innerHeight - rail.offsetHeight - 16);
        access = { ...access, side: e.clientX < window.innerWidth / 2 ? 'left' : 'right',
            position: Math.max(0, Math.min(1, (gesture.top + e.clientY - gesture.y - 8) / range)) };
        place();
    }
    function end(e) {
        if (!gesture || gesture.id !== e.pointerId) return;
        const moved = gesture.moved; gesture = null;
        if (rail.hasPointerCapture(e.pointerId)) rail.releasePointerCapture(e.pointerId);
        if (moved) { suppressClick = true; save({ side: access.side, position: access.position }); }
        schedule();
    }
    function click(e) {
        if (suppressClick) { suppressClick = false; if (e.detail !== 0) { e.preventDefault(); e.stopImmediatePropagation(); } }
    }
    handle.onkeydown = e => {
        if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
        e.preventDefault();
        save(e.key === 'ArrowLeft' || e.key === 'ArrowRight' ? { side: e.key === 'ArrowLeft' ? 'left' : 'right' }
            : { position: Math.max(0, Math.min(1, access.position + (e.key === 'ArrowUp' ? -.05 : .05))) });
    };
    reveal.onclick = () => { suppressClick = false; expand(); handle.focus(); schedule(); };
    rail.addEventListener('pointerdown', down); rail.addEventListener('click', click, true);
    rail.addEventListener('pointerenter', clear); rail.addEventListener('pointerleave', schedule);
    rail.addEventListener('focusout', schedule);
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
    window.addEventListener('resize', place); window.visualViewport?.addEventListener('resize', place);
    return { sync, dispose() {
        clear(); gesture = null;
        rail.removeEventListener('pointerdown', down); rail.removeEventListener('click', click, true);
        rail.removeEventListener('pointerenter', clear); rail.removeEventListener('pointerleave', schedule); rail.removeEventListener('focusout', schedule);
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end);
        window.removeEventListener('resize', place); window.visualViewport?.removeEventListener('resize', place);
        handle.remove(); reveal.remove();
    } };
}
