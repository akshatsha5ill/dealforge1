import { z } from 'zod';
import { Request, Response, NextFunction } from 'express';
import { AppError } from './errorHandler.js';

export const validateRequest = (schema: { body?: z.ZodType; query?: z.ZodType; params?: z.ZodType }) =>
  (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schema.body) {
        req.body = schema.body.parse(req.body);
      }
      if (schema.query) {
        req.query = schema.query.parse(req.query) as Record<string, string>;
      }
      if (schema.params) {
        req.params = schema.params.parse(req.params) as Record<string, string>;
      }
      next();
    } catch (err: unknown) {
      if (err instanceof z.ZodError) {
        return next(new AppError('invalid input', 400));
      }
      next(err);
    }
  };
