import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdater } from '../src/updates.js';

const version = { currentBranchName: 'codex/settings-ui-preview', currentCommitHash: 'old', remoteUrl: 'https://example.test/repo', isUpToDate: false };
function fixture({ type = 'local', responses = [version], pathname = 'old-install-name' } = {}) {
    const calls = [];
    const updater = createUpdater({ getContext: () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'synthetic' }) }) },
        `https://tavern.example/scripts/extensions/third-party/${pathname}/`, {
            loadExtensions: async () => ({ extensionTypes: { [`third-party/${pathname}`]: type } }),
            fetcher: async (url, options) => { calls.push({ url, ...options }); const result = responses.shift(); if (result instanceof Error) throw result; return { ok: true, json: async () => result }; },
        });
    return { updater, calls };
}
test('更新使用实际旧安装目录、宿主请求头及本地/全局位置；检查不下载', async () => {
    for (const type of ['local', 'global']) {
        const { updater, calls } = fixture({ type });
        await updater.check(); assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/extensions/version');
        assert.deepEqual(JSON.parse(calls[0].body), { extensionName: 'old-install-name', global: type === 'global' });
        assert.equal(calls[0].headers['X-CSRF-Token'], 'synthetic');
    }
});
test('更新前重核分支；只调用宿主更新接口，不切换分支', async () => {
    const { updater, calls } = fixture({ responses: [version, version, { shortCommitHash: 'new' }] });
    const info = await updater.check(); await updater.update(info);
    assert.deepEqual(calls.map(c => c.url), ['/api/extensions/version', '/api/extensions/version', '/api/extensions/update']);
    for (const c of calls) assert.deepEqual(Object.keys(JSON.parse(c.body)).sort(), ['extensionName', 'global']);
});
test('检查后安装分支或来源改变时拒绝更新；已最新不重复下载', async () => {
    for (const changed of [{ currentBranchName: 'main' }, { remoteUrl: 'https://example.test/other' }]) {
        const { updater, calls } = fixture({ responses: [{ ...version, ...changed }] });
        await assert.rejects(updater.update(version), /已改变/); assert.equal(calls.length, 1);
    }
    const { updater, calls } = fixture({ responses: [{ ...version, isUpToDate: true }] });
    await updater.update(version); assert.equal(calls.length, 1);
});
test('非 Git、缺失位置、不完整结果和服务失败都不能宣称最新或更新成功', async () => {
    for (const result of [{ currentBranchName: '', currentCommitHash: '', isUpToDate: true, remoteUrl: '' }, { ...version, isUpToDate: undefined }]) {
        await assert.rejects(fixture({ responses: [result] }).updater.check());
    }
    const missing = fixture({ type: '' }); await assert.rejects(missing.updater.check(), /安装位置/); assert.equal(missing.calls.length, 0);
    await assert.rejects(fixture({ responses: [new Error('synthetic failure')] }).updater.check(), /synthetic failure/);
    await assert.rejects(fixture({ responses: [version, {}] }).updater.update(version), /未能确认/);
});
