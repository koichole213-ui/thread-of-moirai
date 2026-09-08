const PRESET_STATE_PREFIX = 'preset:';

function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function booleanEntryStates(value) {
    if (!isRecord(value)) return {};
    return Object.fromEntries(
        Object.entries(value).filter(([, state]) => state === true || state === false),
    );
}

export function presetEntryStateStorageKey(presetName) {
    const name = String(presetName || '').trim();
    return name ? `${PRESET_STATE_PREFIX}${name}` : '';
}

export function normalizePresetEntryStatesByPreset(value) {
    if (!isRecord(value)) return {};
    return Object.fromEntries(
        Object.entries(value)
            .filter(([key, states]) => String(key).startsWith(PRESET_STATE_PREFIX) && isRecord(states))
            .map(([key, states]) => [key, booleanEntryStates(states)]),
    );
}

export function presetEntryStatesForPreset(statesByPreset, presetName, { create = false } = {}) {
    if (!isRecord(statesByPreset)) return {};
    const key = presetEntryStateStorageKey(presetName);
    if (!key) return {};
    if (isRecord(statesByPreset[key])) return statesByPreset[key];
    if (!create) return {};
    statesByPreset[key] = {};
    return statesByPreset[key];
}

export function migrateLegacyPresetEntryStates({ selectedPresetName, legacyStates, statesByPreset }) {
    const migrated = normalizePresetEntryStatesByPreset(statesByPreset);
    const legacy = booleanEntryStates(legacyStates);
    const key = presetEntryStateStorageKey(selectedPresetName);
    if (key && Object.keys(legacy).length && !Object.keys(migrated[key] || {}).length) {
        migrated[key] = legacy;
    }
    return migrated;
}
