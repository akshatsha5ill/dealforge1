import { FilterXSS } from 'xss';

const myXss = new FilterXSS({
  whiteList: {}, // empty, means filter out all tags
  stripIgnoreTag: true,
  // Strip the bodies of tags whose text content is executable or loadable.
  // `script` content must go; `style`/`iframe`/`object`/`embed` bodies are
  // inert once their tags are stripped, but dropping them too avoids leaking
  // CSS/URL text into stored fields.
  stripIgnoreTagBody: ['script', 'style', 'iframe', 'object', 'embed']
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
