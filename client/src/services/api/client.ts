import { auth } from '../firebase/config';

const BASE_URL = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api`
  : '/api';

const getHeaders = async (): Promise<Record<string, string>> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth.currentUser) {
    try {
      const token = await auth.currentUser.getIdToken();
      headers['Authorization'] = `Bearer ${token}`;
    } catch (error) {
      console.warn('Failed to get auth token:', error);
    }
  }
  return headers;
};

const handleResponse = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || `API error: ${response.statusText}`);
  }
  return response.json();
};

export const apiClient = {
  get: async <T = Record<string, unknown>>(endpoint: string, extraHeaders?: Record<string, string>): Promise<T> => {
    const response = await fetch(`${BASE_URL}${endpoint}`, {
      headers: { ...(await getHeaders()), ...(extraHeaders || {}) },
    });
    return handleResponse<T>(response);
  },
  post: async <T = Record<string, unknown>>(endpoint: string, data?: Record<string, unknown>, extraHeaders?: Record<string, string>): Promise<T> => {
    const response = await fetch(`${BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: { ...(await getHeaders()), ...(extraHeaders || {}) },
      body: data ? JSON.stringify(data) : undefined,
    });
    return handleResponse<T>(response);
  },
  put: async <T = Record<string, unknown>>(endpoint: string, data: Record<string, unknown>): Promise<T> => {
    const response = await fetch(`${BASE_URL}${endpoint}`, {
      method: 'PUT',
      headers: await getHeaders(),
      body: JSON.stringify(data),
    });
    return handleResponse<T>(response);
  },
  patch: async <T = Record<string, unknown>>(endpoint: string, data: Record<string, unknown>): Promise<T> => {
    const response = await fetch(`${BASE_URL}${endpoint}`, {
      method: 'PATCH',
      headers: await getHeaders(),
      body: JSON.stringify(data),
    });
    return handleResponse<T>(response);
  },
  delete: async <T = Record<string, unknown>>(endpoint: string): Promise<T> => {
    const response = await fetch(`${BASE_URL}${endpoint}`, {
      method: 'DELETE',
      headers: await getHeaders(),
    });
    return handleResponse<T>(response);
  },

  createCheckout: async (plan: string): Promise<{ checkout_url: string }> => {
    return apiClient.post<{ checkout_url: string }>('/billing/checkout', { plan });
  },

  getSubscription: async (): Promise<{ plan: string; status: string; currentPeriodEnd: string | null; customerId: string | null; subscriptionId: string | null }> => {
    return apiClient.get('/billing/subscription');
  },

  cancelSubscription: async (): Promise<void> => {
    await apiClient.post('/billing/cancel');
  },

  verifyCheckout: async (sessionId: string, plan: string): Promise<Record<string, unknown>> => {
    return apiClient.post('/billing/verify', { session_id: sessionId, plan });
  },
};
