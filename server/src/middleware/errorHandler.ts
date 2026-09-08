import { Request, Response, NextFunction } from 'express';
import log from '../utils/logger.js';

export class AppError extends Error {
  public statusCode: number;
  public isOperational: boolean;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

export const errorHandler = (err: Error & { statusCode?: number; status?: number }, req: Request, res: Response, _next: NextFunction) => {
  // Only log full errors for actual server faults, not validation errors
  if (!err.statusCode || err.statusCode >= 500) {
      log.error(err.message || 'Internal Server Error', { stack: err.stack, path: req.path });
  }

  // Handle manual AppErrors
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      status: 'error',
      error: err.message,
    });
  }

  // Fallback for general errors
  return res.status(err.status || err.statusCode || 500).json({
    status: 'error',
    error: err.status === 400 || err.statusCode === 400 ? (err.message || 'invalid input') : 'Internal Server Error',
  });
};
