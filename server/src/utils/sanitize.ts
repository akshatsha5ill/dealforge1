import { FilterXSS, type IFilterXSSOptions } from 'xss';

const myXss = new FilterXSS({
  whiteList: {}, // empty, means filter out all tags
  stripIgnoreTag: true,
  stripIgnoreTagBody: ['script'] // the script tag is a special case, we need to filter out its content
});

export const sanitizeObject = <T>(obj: T): T => {
  if (typeof obj === 'string') {
    return myXss.process(obj) as T;
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizeObject) as T;
  }
  if (typeof obj === 'object' && obj !== null) {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }
      Object.defineProperty(sanitized, key, {
        value: sanitizeObject(value),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return sanitized as T;
  }
  return obj;
};
