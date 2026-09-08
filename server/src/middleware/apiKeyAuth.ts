import { Request, Response, NextFunction } from 'express';
import { findApiKeyOwner, touchApiKeyLastUsed } from '../services/api-key-service.js';
import { AppError } from './errorHandler.js';
import log from '../utils/logger.js';

export const API_KEY_HEADER = 'x-api-key';

export async function apiKeyAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const raw = req.headers[API_KEY_HEADER];
  // Express may parse repeated headers as string[] — never pass an array into
  // the key lookup (it would throw inside the hash). Reject outright.
  const key = Array.isArray(raw) ? undefined : raw;
  if (!key) {
    return next(new AppError('Unauthorized: Missing API key', 401));
  }
  try {
    const owner = await findApiKeyOwner(key);
    if (!owner) {
      return next(new AppError('Unauthorized: Invalid API key', 401));
    }
    (req as unknown as { user?: { uid: string } }).user = { uid: owner.uid };
    (req as unknown as { apiKeyHash?: string }).apiKeyHash = owner.keyHash;
    void Promise.resolve(touchApiKeyLastUsed(owner.keyHash)).catch((err) => {
      log.warn('Failed to touch API key last-used', { error: (err as Error)?.message });
    });
    next();
  } catch (err) {
    log.warn('API key validation failed', { error: (err as Error)?.message });
    next(new AppError('Failed to validate API key', 500));
  }
}
