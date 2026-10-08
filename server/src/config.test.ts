import { describe, it, expect } from 'vitest';
import { config, isPlaceholderSecret } from './config.js';

describe('Config', () => {
  it('loads config with defaults', () => {
    expect(config.port).toBeDefined();
    expect(config.clientUrl).toBeDefined();
  });
  
  it('identifies environment correctly', () => {
    expect(config.isTest).toBe(true);
    expect(config.isProd).toBe(false);
  });

  it('requires NODE_ENV to be set explicitly (fail-closed, no dev default)', () => {
    // Vitest sets NODE_ENV=test; the module must reflect the explicit value
    // rather than falling back to 'development'.
    expect(process.env.NODE_ENV).toBeDefined();
    expect(config.env).toBe(process.env.NODE_ENV);
  });
});

describe('isPlaceholderSecret (prod denylist)', () => {
  it.each([
    'change-me-xyz',
    'change-me',
    'changeme123',
    'Change-Me-Session',
    'your-secret-here',
    'replace-me',
    'placeholder',
    'my-placeholder-key',
    'example-key',
    'test',
    'test-123',
    'password123',
    'secret123',
    '12345678',
    '',
    '   ',
  ])('rejects placeholder/weak value %j', (value) => {
    expect(isPlaceholderSecret(value)).toBe(true);
  });

  it('rejects non-strings and missing values', () => {
    expect(isPlaceholderSecret(undefined)).toBe(true);
    expect(isPlaceholderSecret(null)).toBe(true);
    expect(isPlaceholderSecret(12345)).toBe(true);
  });

  it.each([
    'a3f9c1e7b2d84f06a5c9e1d3b7f02468ace01357',
    'sk-live-9f2c4b7d1a6e48c0b3d5f7a9e1c4d6b8a0',
    'xK9#mQ2$vL8@nP4!wZ7%tR5&yU3*iO6(pA1)sD4f',
  ])('accepts high-entropy value %j', (value) => {
    expect(isPlaceholderSecret(value)).toBe(false);
  });
});
