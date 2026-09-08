import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

// Client-supplied IDs are untrusted: accept only short token-safe values so
// the echoed X-Request-Id header and request logs can't be used for log
// forgery or response splitting. Anything else gets a fresh UUID.
const SAFE_REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const requestId = (req: Request, res: Response, next: NextFunction) => {
  const raw = req.headers['x-request-id'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  const id = (typeof header === 'string' && SAFE_REQUEST_ID_RE.test(header)) ? header : crypto.randomUUID();
  (req as Request & { requestId: string }).requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
};

export default requestId;
