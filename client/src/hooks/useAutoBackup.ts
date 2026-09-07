import { useEffect } from 'react';
import { exportAllData, downloadJSON } from '../services/local-db/backup';

export function useAutoBackup() {
  useEffect(() => {
    const checkAutoBackup = async () => {
      try {
        const isEnabled = localStorage.getItem('dealforge_autobackup') === 'true';
        if (!isEnabled) return;

        const lastBackupStr = localStorage.getItem('dealforge_last_autobackup');
        const now = new Date();
        
        if (lastBackupStr) {
          const lastBackup = new Date(lastBackupStr);
          // Check if 24 hours have passed
          if (now.getTime() - lastBackup.getTime() < 24 * 60 * 60 * 1000) {
            return;
          }
        }

        const data = await exportAllData();
        downloadJSON(data, `dealforge-autobackup-${now.toISOString().split('T')[0]}.json`);
        localStorage.setItem('dealforge_last_autobackup', now.toISOString());
      } catch {
        // Auto-backup is best-effort; failures stay silent.
      }
    };

    // Delay the check slightly to avoid blocking initial render
    const timer = setTimeout(checkAutoBackup, 5000);
    return () => clearTimeout(timer);
  }, []);
}
