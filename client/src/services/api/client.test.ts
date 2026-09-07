import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiClient } from './client';
import { auth } from '../firebase/config';

// Mock the firebase config
vi.mock('../firebase/config', () => ({
  auth: {
    currentUser: null,
  },
}));

// Determine the expected base URL based on env (matches client.ts logic)
const BASE_URL = (import.meta.env.VITE_API_URL || '') + '/api';

describe('apiClient', () => {
  beforeEach(() => {
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn();
    (auth as unknown as { currentUser: unknown }).currentUser = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const mockFetchSuccess = (data: unknown) => {
    (globalThis.fetch as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce({
      ok: true,
      json: async () => data,
    });
  };

  const mockFetchError = (statusText: string, errorData: unknown) => {
    (globalThis.fetch as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce({
      ok: false,
      statusText,
      json: async () => errorData,
    });
  };

  describe('Headers & Auth', () => {
    it('should send default headers when user is not authenticated', async () => {
      mockFetchSuccess({ data: 'success' });
      await apiClient.get('/test');

      expect(globalThis.fetch).toHaveBeenCalledWith(`${BASE_URL}/test`, {
        headers: { 'Content-Type': 'application/json' },
      });
    });

    it('should attach Authorization header when user is authenticated', async () => {
      mockFetchSuccess({ data: 'success' });
      const mockToken = 'mock-jwt-token';

      (auth as unknown as { currentUser: unknown }).currentUser = {
        getIdToken: vi.fn().mockResolvedValue(mockToken),
      };

      await apiClient.get('/test-auth');

      expect(globalThis.fetch).toHaveBeenCalledWith(`${BASE_URL}/test-auth`, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${mockToken}`
        },
      });
      expect((auth.currentUser as unknown as { getIdToken: () => Promise<string> }).getIdToken).toHaveBeenCalled();
    });

    it('should fallback to default headers if getIdToken fails', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockFetchSuccess({ data: 'success' });
      const error = new Error('Token error');
      (auth as unknown as { currentUser: unknown }).currentUser = {
        getIdToken: vi.fn().mockRejectedValue(error),
      };

      await apiClient.get('/test-auth-fail');

      expect(globalThis.fetch).toHaveBeenCalledWith(`${BASE_URL}/test-auth-fail`, {
        headers: { 'Content-Type': 'application/json' },
      });
      expect(consoleSpy).toHaveBeenCalledWith('Failed to get auth token:', error);
      consoleSpy.mockRestore();
    });
  });

  describe('HTTP Methods', () => {
    it('should correctly execute a GET request', async () => {
      const mockData = { id: 1, name: 'Test' };
      mockFetchSuccess(mockData);

      const result = await apiClient.get('/items');

      expect(result).toEqual(mockData);
      expect(globalThis.fetch).toHaveBeenCalledWith(`${BASE_URL}/items`, {
        headers: { 'Content-Type': 'application/json' },
      });
    });

    it('should correctly execute a POST request', async () => {
      const mockData = { success: true };
      const requestData = { name: 'New Item' };
      mockFetchSuccess(mockData);

      const result = await apiClient.post('/items', requestData);

      expect(result).toEqual(mockData);
      expect(globalThis.fetch).toHaveBeenCalledWith(`${BASE_URL}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestData),
      });
    });

    it('should correctly execute a PUT request', async () => {
      const mockData = { success: true };
      const requestData = { name: 'Updated Item' };
      mockFetchSuccess(mockData);

      const result = await apiClient.put('/items/1', requestData);

      expect(result).toEqual(mockData);
      expect(globalThis.fetch).toHaveBeenCalledWith(`${BASE_URL}/items/1`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestData),
      });
    });

    it('should correctly execute a PATCH request', async () => {
      const mockData = { success: true };
      const requestData = { name: 'Patched Item' };
      mockFetchSuccess(mockData);

      const result = await apiClient.patch('/items/1', requestData);

      expect(result).toEqual(mockData);
      expect(globalThis.fetch).toHaveBeenCalledWith(`${BASE_URL}/items/1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestData),
      });
    });

    it('should correctly execute a DELETE request', async () => {
      const mockData = { success: true };
      mockFetchSuccess(mockData);

      const result = await apiClient.delete('/items/1');

      expect(result).toEqual(mockData);
      expect(globalThis.fetch).toHaveBeenCalledWith(`${BASE_URL}/items/1`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      });
    });
  });

  describe('Error Handling', () => {
    it('should throw an error with the JSON error message if provided', async () => {
      mockFetchError('Bad Request', { error: 'Validation failed' });

      await expect(apiClient.get('/error')).rejects.toThrow('Validation failed');
    });

    it('should fallback to statusText if JSON error parsing fails', async () => {
      // Mock fetch to simulate a response where parsing JSON fails
      (globalThis.fetch as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce({
        ok: false,
        statusText: 'Internal Server Error',
        json: async () => { throw new Error('Invalid JSON'); },
      });

      await expect(apiClient.get('/error-fallback')).rejects.toThrow('Internal Server Error');
    });
  });
});
