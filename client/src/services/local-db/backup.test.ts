import { describe, it, expect } from 'vitest';
import {
  parseAndValidateBackupData,
  MAX_BACKUP_FILE_BYTES,
  MAX_ARRAY_ITEMS,
  SETTINGS_IMPORT_ALLOWLIST,
} from './backup';

describe('backup import validation', () => {
  it('accepts a minimal valid backup', () => {
    const clean = parseAndValidateBackupData({
      meetings: [{ id: 'm1', zoomMeetingId: 'z1', title: 'T', startTime: '', endTime: '', duration: 60, status: 'completed' }],
      settings: [{ key: 'onboarding_complete', value: true }],
      exportedAt: new Date().toISOString(),
    });
    expect(clean.meetings).toHaveLength(1);
    expect(clean.settings).toHaveLength(1);
  });

  it('rejects rows missing required id', () => {
    expect(() =>
      parseAndValidateBackupData({ meetings: [{ title: 'no id' }] }),
    ).toThrow();
  });

  it('rejects unknown top-level keys (fail-closed strict schema)', () => {
    expect(() => parseAndValidateBackupData({ meetings: [], evil: [] })).toThrow();
  });

  it('enforces per-collection array caps', () => {
    const big = Array.from({ length: MAX_ARRAY_ITEMS + 1 }, (_, i) => ({ id: `m${i}` }));
    expect(() => parseAndValidateBackupData({ meetings: big })).toThrow();
  });

  it('allow-lists settings keys and drops the rest', () => {
    const clean = parseAndValidateBackupData({
      settings: [
        { key: 'onboarding_complete', value: true },
        { key: 'backup_dir_handle', value: { fake: 'handle' } },
        { key: 'attacker_flag', value: true },
        { key: '__proto__', value: { polluted: true } },
      ],
    });
    const keys = (clean.settings ?? []).map((s) => s.key);
    expect(keys).toEqual(['onboarding_complete']);
    for (const k of keys) {
      expect(SETTINGS_IMPORT_ALLOWLIST.has(k)).toBe(true);
    }
  });

  it('drops all settings when none are allow-listed', () => {
    const clean = parseAndValidateBackupData({
      settings: [{ key: 'nope', value: 1 }],
    });
    expect(clean.settings).toBeUndefined();
  });

  it('exposes a 20MB file-size cap', () => {
    expect(MAX_BACKUP_FILE_BYTES).toBe(20 * 1024 * 1024);
  });

  it('caps oversized string fields', () => {
    expect(() =>
      parseAndValidateBackupData({
        meetings: [{ id: 'm1', title: 'x'.repeat(501) }],
      }),
    ).toThrow();
  });
});
