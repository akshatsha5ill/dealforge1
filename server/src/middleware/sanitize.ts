import { Request, Response, NextFunction } from 'express';
import { sanitizeObject } from '../utils/sanitize.js';

const sanitize = (req: Request, res: Response, next: NextFunction) => {
  if (req.body && typeof req.body === 'object') {
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
