import { useState, useEffect, useCallback } from 'react';
import { CheckCircle, AlertCircle, Info, X } from 'lucide-react';

type ToastType = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

let toastId = 0;
let listeners: ((toasts: Toast[]) => void)[] = [];
let toasts: Toast[] = [];

// Bound bursts (e.g. a failing loop) to a fixed window so the module-level
// array and re-renders can't grow without limit.
const MAX_TOASTS = 5;

function notify() {
  listeners.forEach((l) => l([...toasts]));
}

export function showToast(message: string, type: ToastType = 'info') {
  const id = ++toastId;
  toasts = [...toasts, { id, message, type }].slice(-MAX_TOASTS);
  notify();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    notify();
  }, 4000);
}

export const toast = {
  success: (msg: string) => showToast(msg, 'success'),
  error: (msg: string) => showToast(msg, 'error'),
  info: (msg: string) => showToast(msg, 'info'),
};

const icons: Record<ToastType, typeof CheckCircle> = {
  success: CheckCircle,
  error: AlertCircle,
  info: Info,
};

const colors: Record<ToastType, string> = {
  success: 'var(--success)',
  error: 'var(--danger)',
  info: 'var(--accent-primary)',
};

export default function ToastContainer() {
  const [items, setItems] = useState<Toast[]>([]);

  useEffect(() => {
    const handler = (t: Toast[]) => setItems(t);
    listeners.push(handler);
    return () => {
      listeners = listeners.filter((l) => l !== handler);
    };
  }, []);

  const dismiss = useCallback((id: number) => {
    toasts = toasts.filter((t) => t.id !== id);
    notify();
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="toast-container" role="alert" aria-live="polite">
      {items.map((t) => {
        const Icon = icons[t.type];
        return (
          <div key={t.id} className="toast-item" style={{ borderLeftColor: colors[t.type] }}>
            <Icon size={16} style={{ color: colors[t.type], flexShrink: 0 }} />
            <span className="toast-message">{t.message}</span>
            <button className="toast-dismiss" onClick={() => dismiss(t.id)}>
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
