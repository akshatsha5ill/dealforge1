import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

let app: FirebaseApp | undefined;
let auth: Auth;

try {
  if (!firebaseConfig.apiKey) {
    throw new Error('Firebase configuration is missing.');
  }
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
} catch (error) {
  console.warn('Running without Firebase (redirects to /login when auth is required):', error);
  // Dummy auth keeps the app shell alive without configuration.
  // Callers must handle the thrown "Firebase not configured" errors by
  // redirecting to /login with a configuration banner.
  auth = {
    onAuthStateChanged: (cb: (user: null) => void) => { cb(null); return () => {}; },
    currentUser: null,
    signInWithEmailAndPassword: async () => { throw new Error('Firebase not configured'); },
    createUserWithEmailAndPassword: async () => { throw new Error('Firebase not configured'); },
    signOut: async () => {}
  } as unknown as Auth;
}

export { auth };
export default app;
