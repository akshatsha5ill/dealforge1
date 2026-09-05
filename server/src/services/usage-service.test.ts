import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getMonthKey, getMonthlyAnalysisCount, getMonthlyAnalysisCountWithFallback, recordAnalysisUsage } from './usage-service.js';

const setFn = vi.fn();
const listFn = vi.fn();

vi.mock('./firebase-admin.js', () => ({
  getFirebaseFirestore: () => ({
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            set: setFn,
            collection: () => ({
              listDocuments: listFn,
              doc: () => ({ set: setFn }),
            }),
          }),
        }),
      }),
    }),
  }),
}));

describe('usage-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getMonthKey', () => {
    it('formats YYYY-MM for a given date', () => {
      expect(getMonthKey(new Date('2026-08-15T10:00:00Z'))).toBe('2026-08');
    });

    it('pads single-digit months', () => {
      expect(getMonthKey(new Date('2026-01-05T10:00:00Z'))).toBe('2026-01');
    });
  });

  describe('getMonthlyAnalysisCount', () => {
    it('counts analysis documents for a user/month', async () => {
      listFn.mockResolvedValueOnce([{}, {}, {}]);
      const count = await getMonthlyAnalysisCount('user-1', '2026-08');
      expect(count).toBe(3);
    });

    it('returns 0 when there are no analyses', async () => {
      listFn.mockResolvedValueOnce([]);
      const count = await getMonthlyAnalysisCount('user-1', '2026-08');
      expect(count).toBe(0);
    });

    it('fails closed when Firestore is unavailable (enforcement path throws)', async () => {
      listFn.mockRejectedValueOnce(new Error('not configured'));
      await expect(getMonthlyAnalysisCount('user-1', '2026-08')).rejects.toThrow('not configured');
    });

    it('fails open on the display/diagnostic path', async () => {
      listFn.mockRejectedValueOnce(new Error('not configured'));
      const count = await getMonthlyAnalysisCountWithFallback('user-1', '2026-08');
      expect(count).toBe(0);
    });
  });

  describe('recordAnalysisUsage', () => {
    it('records a meeting analysis for a user/month', async () => {
      setFn.mockResolvedValueOnce(undefined);
      await expect(recordAnalysisUsage('user-1', 'meeting-1', '2026-08')).resolves.toBeUndefined();
      expect(setFn).toHaveBeenCalledWith(expect.objectContaining({ at: expect.any(String) }));
    });

    it('does not throw when Firestore is unavailable', async () => {
      setFn.mockRejectedValueOnce(new Error('not configured'));
      await expect(recordAnalysisUsage('user-1', 'meeting-1', '2026-08')).resolves.toBeUndefined();
    });
  });
});
