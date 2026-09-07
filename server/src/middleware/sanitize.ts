import { Request, Response, NextFunction } from 'express';
import { sanitizeObject } from '../utils/sanitize.js';

const sanitize = (req: Request, res: Response, next: NextFunction) => {
  // Skip body sanitize for email send: body is HTML and routes/email.ts
  // click-wraps <a href> + appends <img> pixel (global strip leaves nothing to wrap).
  const url = (req.originalUrl || (req as { url?: string }).url || '').split('?')[0];
  const isEmailSend =
    req.method === 'POST' && (url === '/api/email/send' || url.endsWith('/api/email/send'));
  if (!isEmailSend && req.body && typeof req.body === 'object') {
    req.body = sanitizeObject(req.body);
  }
  if (req.query && typeof req.query === 'object') {
    const sanitizedQuery = sanitizeObject(req.query);
    for (const key of Object.keys(req.query)) {
      delete (req.query as Record<string, unknown>)[key];
    }
    Object.assign(req.query, sanitizedQuery);
  }
  if (req.params && typeof req.params === 'object') {
    req.params = sanitizeObject(req.params);
  }
  next();
};

export default sanitize;
