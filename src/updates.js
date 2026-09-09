// Use the host's extension updater so the installed folder and branch stay intact.
export function createUpdater(host, baseURL, { fetcher = (...args) => fetch(...args), loadExtensions = () => import('/scripts/extensions.js') } = {}) {
    let target;
    async function request(action, signal) {
        if (!target) {
            const url = new URL(baseURL), match = url.pathname.match(/\/scripts\/extensions\/third-party\/([^/]+)\/$/);
            if (!match) throw new Error('请在酒馆安装的插件中检查更新。');
            const extensionName = decodeURIComponent(match[1]);
            const { extensionTypes } = await loadExtensions();
            const type = extensionTypes?.[`third-party/${extensionName}`];
            if (!['local', 'global'].includes(type)) throw new Error('无法确认安装位置，请使用酒馆扩展管理更新。');
            target = { extensionName, global: type === 'global' };
        }
        const response = await fetcher(`/api/extensions/${action}`, {
            method: 'POST', headers: host.getContext().getRequestHeaders(), body: JSON.stringify(target), signal,
        });
        if (!response.ok) throw new Error(response.status === 403 ? '没有更新权限，请联系酒馆管理员。' : '更新服务暂不可用，请稍后重试或使用酒馆扩展管理。');
        return response.json();
    }
    async function check(signal) {
        const info = await request('version', signal);
        if (!info.currentBranchName || !info.currentCommitHash || !info.remoteUrl) throw new Error('此安装不支持在线更新，请使用酒馆扩展管理。');
        if (typeof info.isUpToDate !== 'boolean') throw new Error('检查结果不完整，请稍后重试。');
        return info;
    }
    return { check, async update(expected, signal) {
        const current = await check(signal);
        if (current.currentBranchName !== expected.currentBranchName || current.remoteUrl !== expected.remoteUrl) throw new Error('安装分支或来源已改变，请重新检查更新。');
        if (current.isUpToDate) return;
        const result = await request('update', signal);
        if (!result.shortCommitHash) throw new Error('未能确认更新结果，请重新检查。');
    } };
}

export function mountUpdater(root, { updater, canReload, reload = () => location.reload() }) {
    const check = root.querySelector('#ref-check-update'), apply = root.querySelector('#ref-apply-update');
    const refresh = root.querySelector('#ref-reload-update'), status = root.querySelector('#ref-update-status');
    let info, loadedCommit, controller, disposed = false, busy = false;
    async function run(update) {
        if (busy || disposed) return;
        busy = true; check.disabled = apply.disabled = true;
        status.textContent = update ? '正在更新，请稍候…' : '正在检查…';
        controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), update ? 120000 : 30000);
        try {
            if (update) {
                await updater.update(info, controller.signal);
                if (disposed) return;
                apply.hidden = check.hidden = true; refresh.hidden = false;
                status.textContent = '更新已就绪，刷新页面后生效。';
            } else {
                info = await updater.check(controller.signal);
                if (disposed) return;
                loadedCommit ||= info.currentCommitHash;
                if (info.currentCommitHash !== loadedCommit) {
                    apply.hidden = check.hidden = true; refresh.hidden = false;
                    status.textContent = '安装内容已改变，刷新页面后生效。';
                    return;
                }
                apply.hidden = info.isUpToDate;
                status.textContent = info.isUpToDate ? '当前分支已是最新。' : '当前分支有更新。';
            }
        } catch (error) {
            if (disposed) return;
            apply.hidden = true; info = null;
            status.textContent = controller.signal.aborted ? (update ? '更新结果尚未确认，请稍后重新检查；无需重复点击更新。' : '检查超时，请重试。') : error.message;
        } finally { clearTimeout(timer); busy = false; if (!disposed) check.disabled = apply.disabled = false; }
    }
    check.onclick = () => run(false); apply.onclick = () => { if (info) void run(true); };
    refresh.onclick = () => {
        if (!canReload()) { status.textContent = '请先保存或取消未保存的设置，再刷新。'; return; }
        if (confirm('刷新页面以启用更新？请先保留输入框中尚未发送的内容。')) reload();
    };
    return { dispose() { disposed = true; controller?.abort(); } };
}
