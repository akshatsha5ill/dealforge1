import { useState } from 'react';
import { useWebSocket, getSharedSocket } from '../../hooks/useWebSocket';

const DB_NAME = 'dealforge-notes';
const STORE_NAME = 'pending_notes';
const ACK_TIMEOUT_MS = 5000;

function openNotesDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function persistNoteToIndexedDB(payload: { content: string; timestamp: string }): Promise<number | null> {
  // Fallback for environments without IndexedDB (e.g. tests / SSR): keep locally via localStorage.
  if (typeof indexedDB === 'undefined') {
    try {
      const key = 'dealforge-pending-notes';
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
      const arr = raw ? JSON.parse(raw) : [];
      arr.push({ ...payload, synced: false });
      if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(arr));
    } catch {
      // ignore fallback errors — caller still keeps note in textarea
    }
    return null;
  }
  const db = await openNotesDB();
  try {
    const id = await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const addReq = store.add({ ...payload, synced: false, createdAt: new Date().toISOString() });
      let newId = 0;
      addReq.onsuccess = () => {
        newId = Number(addReq.result);
      };
      addReq.onerror = () => reject(addReq.error);
      tx.oncomplete = () => resolve(newId);
      tx.onerror = () => reject(tx.error);
    });
    return id;
  } finally {
    db.close();
  }
}

async function removeNoteFromIndexedDB(id: number): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try {
    const db = await openNotesDB();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  } catch {
    // best-effort cleanup — local copy remaining is safe (no data loss)
  }
}

function emitWithAck(event: string, data: unknown, timeoutMs = ACK_TIMEOUT_MS): Promise<void> {
  const socket = getSharedSocket();
  if (!socket || !socket.connected) {
    return Promise.reject(new Error('socket not connected'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('ack timeout'));
      }
    }, timeoutMs);
    try {
      (socket as unknown as { emit: (ev: string, d: unknown, cb: (ack?: unknown) => void) => void }).emit(
        event,
        data,
        (ack?: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (ack == null || ack === true) {
            resolve();
            return;
          }
          if (ack === false) {
            reject(new Error('server rejected note'));
            return;
          }
          if (typeof ack === 'object') {
            const r = ack as Record<string, unknown>;
            if ('ok' in r) {
              if (r.ok) resolve();
              else reject(new Error(typeof r.error === 'string' ? r.error : 'server rejected note'));
              return;
            }
            if ('success' in r) {
              if (r.success) resolve();
              else reject(new Error(typeof r.error === 'string' ? r.error : 'server rejected note'));
              return;
            }
            if ('error' in r && r.error) {
              reject(new Error(typeof r.error === 'string' ? r.error : 'server rejected note'));
              return;
            }
          }
          resolve();
        },
      );
    } catch (err) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error('emit failed'));
      }
    }
  });
}

const NotesView = () => {
  const [note, setNote] = useState('');
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  // Keep hook mounted so the shared socket is initialized; emits go via getSharedSocket() with ack checks.
  useWebSocket();

  const handleSave = async () => {
    if (!note.trim() || saving) return;
    setSaved(false);
    setFailed(false);
    setSaving(true);
    const payload = { content: note, timestamp: new Date().toISOString() };
    // 1. Persist to IndexedDB FIRST so a null/disconnected socket can't lose data.
    let localId: number | null = null;
    try {
      localId = await persistNoteToIndexedDB(payload);
    } catch (e) {
      console.error('Failed to persist note locally:', e);
    }
    // 2. Emit with ack check.
    try {
      await emitWithAck('save_note', payload);
      // 3. Only clear on success.
      if (localId != null) {
        await removeNoteFromIndexedDB(localId);
      }
      setSaved(true);
      setNote('');
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      console.error('Failed to save note via socket, kept locally:', e);
      setFailed(true);
      // Do NOT clear note — it stays in the textarea and in IndexedDB.
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: 'var(--bg-primary)', padding: '16px', color: 'var(--text-primary)' }}>
      <h2 style={{ fontSize: '20px', fontWeight: 700, marginBottom: '16px' }}>Quick Notes</h2>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <textarea
          style={{ flex: 1, width: '100%', padding: '16px', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: '12px', resize: 'none', outline: 'none', fontFamily: 'Inter, sans-serif', fontSize: '14px', lineHeight: 1.5 }}
          placeholder="Jot down quick thoughts here... they will sync to your dashboard."
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            if (failed) setFailed(false);
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button onClick={handleSave} disabled={saving} style={{ backgroundColor: 'var(--accent-primary)', color: '#000', fontWeight: 700, padding: '12px 16px', borderRadius: '12px', border: 'none', cursor: saving ? 'wait' : 'pointer', fontSize: '14px', transition: 'background-color 0.2s', opacity: saving ? 0.6 : 1 }}>
            {saving ? 'Saving...' : 'Save Note'}
          </button>
          {saved && <span style={{ color: 'var(--success)', fontSize: '14px' }}>Saved!</span>}
          {failed && <span style={{ color: 'var(--error, #f87171)', fontSize: '14px' }}>Failed — kept locally</span>}
        </div>
      </div>
    </div>
  );
};

export default NotesView;
