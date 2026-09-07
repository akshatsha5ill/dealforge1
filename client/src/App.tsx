import { useEffect, useState } from 'react';
import { RouterProvider } from 'react-router-dom';
import { router } from './routes';
import { initAuthListener } from './services/firebase/auth';
import { leadAutomationService } from './services/lead-automation';
import { dripWorker } from './services/drip-worker';
import { db } from './services/local-db/db';
import { runAutoBackup } from './services/local-db/backup';
import { initAnalytics } from './services/analytics';
import { initReferrals, retryPendingReferral } from './services/referral';
import { useStore } from './store';
import CookieConsent from './components/common/CookieConsent';
import BackupPrompt from './components/common/BackupPrompt';
import ToastContainer, { toast } from './components/common/Toast';
import ConfirmDialogContainer from './components/common/ConfirmDialog';
import './index.css';

type BackupHandle = {
  queryPermission: (opts: { mode: string }) => Promise<string>;
  requestPermission: (opts: { mode: string }) => Promise<string>;
  getFileHandle: (name: string, opts: { create: boolean }) => Promise<{
    createWritable: () => Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }>;
  }>;
};

function App() {
  const [needsBackupPermission, setNeedsBackupPermission] = useState<BackupHandle | null>(null);
  useEffect(() => {
    initAuthListener();
    initAnalytics();
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }

    initReferrals().then((benefit) => {
      if (benefit?.benefit === 'meeting_bonus') {
        toast.success('Referral applied! +1 free meeting analysis for 3 months.');
      } else if (benefit?.benefit === 'free_month') {
        toast.success('Referral applied! You have 1 month of Pro credit.');
      }
    }).catch(() => {
      // Offline or referral service unavailable — non-critical at startup.
    });

    const unsubscribeAuth = useStore.subscribe((state, prevState) => {
      if (state.isAuthenticated && !prevState.isAuthenticated) {
        retryPendingReferral();
      }
    });

    const checkBackup = async () => {
      try {
        const handle = await db.settings.get('backup_dir_handle');
        if (!handle || !handle.value) return;

        const lastBackup = await db.settings.get('last_auto_backup');
        const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
        
        if (!lastBackup || Date.now() - (lastBackup.value as number) > SEVEN_DAYS) {
          // Check if we already have permission without prompting
          const dirHandle = handle.value as BackupHandle;
          const opts = { mode: 'readwrite' } as const;
          if ((await dirHandle.queryPermission(opts)) === 'granted') {
            await runAutoBackup(dirHandle);
          } else {
            setNeedsBackupPermission(dirHandle);
          }
        }
      } catch {
        // Auto-backup check is best-effort; failures stay silent at startup.
      }
    };
    checkBackup();

    return unsubscribeAuth;
  }, []);

  useEffect(() => {
    leadAutomationService.start();
    dripWorker.start();
    
    return () => {
      leadAutomationService.stop();
      dripWorker.stop();
    };
  }, []);

  const handleAllowBackup = async () => {
    if (needsBackupPermission) {
      const success = await runAutoBackup(needsBackupPermission);
      if (success) {
        toast.success('Weekly backup completed successfully!');
        setNeedsBackupPermission(null);
      } else {
        toast.error('Failed to get permission for backup.');
      }
    }
  };

  return (
    <>
      <RouterProvider router={router} />
      <ToastContainer />
      <ConfirmDialogContainer />
      <CookieConsent />
      {needsBackupPermission && (
        <BackupPrompt onAuthorize={handleAllowBackup} />
      )}
    </>
  );
}

export default App;
