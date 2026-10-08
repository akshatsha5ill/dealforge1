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

// DoS bounds for attacker-controlled JSON: max nesting depth, max keys per
// object, max items per array. Payloads beyond these are abusive; containers
// past the depth bound are dropped (fail-closed), extras are truncated.
const MAX_SANITIZE_DEPTH = 10;
const MAX_SANITIZE_KEYS = 100;
const MAX_SANITIZE_ARRAY = 1000;

export const sanitizeObject = <T>(obj: T, depth = 0): T => {
  if (typeof obj === 'string') {
    return myXss.process(obj) as T;
  }
  // Fail-closed depth bound: unbounded recursion on attacker-controlled JSON
  // is a stack-exhaustion DoS. Past MAX_SANITIZE_DEPTH, containers are dropped
  // rather than returned unsanitized (which would be an XSS bypass).
  if (depth >= MAX_SANITIZE_DEPTH) {
    if (typeof obj === 'object' && obj !== null) {
      return (Array.isArray(obj) ? [] : {}) as T;
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.slice(0, MAX_SANITIZE_ARRAY).map((v) => sanitizeObject(v, depth + 1)) as T;
  }
  if (typeof obj === 'object' && obj !== null) {
    const sanitized: Record<string, unknown> = {};
    let count = 0;
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (count >= MAX_SANITIZE_KEYS) break;
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }
      Object.defineProperty(sanitized, key, {
        value: sanitizeObject(value, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
      count += 1;
    }
    return sanitized as T;
  }
  return obj;
};
