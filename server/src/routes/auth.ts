import express from 'express';
const router = express.Router();

// Health check for auth service
router.get('/health', (req, res) => {
  res.status(200).json({ message: 'Auth service healthy', timestamp: new Date().toISOString() });
});

// Test-only helper: never enabled in production or staging.
// Only development/test (or unset NODE_ENV for local dev) return 200; else 404.
// Checks process.env at request time so tests can mutate NODE_ENV.
router.post('/dev-token', (req, res) => {
  const env = process.env.NODE_ENV || 'development';
  if (env !== 'development' && env !== 'test') {
    return res.status(404).json({ error: 'Not available in production' });
  }
  res.status(200).json({
    status: 'success',
    message: 'Use Firebase Auth SDK on the client for real authentication',
  });
});

export default router;
