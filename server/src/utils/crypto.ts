import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
// Domain-separated purposes so one leak does not decrypt everything.
// Bump the version suffix to rotate a single domain without re-encrypting all.
export const CryptoPurpose = {
  ZoomToken: 'zoom-token-v1',
  EmailToken: 'email-token-v1',
  ZoomOAuthState: 'zoom-oauth-state-v1',
  EmailOAuthState: 'email-oauth-state-v1',
  Default: 'data',
} as const;

const KDF_SALT = 'dealforge-kdf-v1';

function getSecrets(): string[] {
  const primary = process.env.ENCRYPTION_KEY;
  if (!primary) {
    throw new Error('FATAL: ENCRYPTION_KEY is not set.');
  }
  const previous = (process.env.ENCRYPTION_PREVIOUS_KEYS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [primary, ...previous];
}

function deriveKey(secret: string, purpose: string): Buffer {
  // HKDF-SHA256 with a fixed app salt and per-purpose info.
  return Buffer.from(crypto.hkdfSync('sha256', secret, KDF_SALT, purpose, 32));
}

function legacyKey(secret: string, purpose: string): Buffer {
  return crypto.createHash('sha256').update(secret + ':' + purpose).digest();
}

function getKey(purpose: string): Buffer {
  return deriveKey(getSecrets()[0], purpose);
}

export function encrypt(text: string, purpose: string = CryptoPurpose.Default): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(purpose), iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag().toString('hex');

  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function tryDecryptWith(key: Buffer, encryptedData: string): string {
  const parts = encryptedData.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted data format');

  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encryptedText = Buffer.from(parts[2], 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedText, undefined, 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

export function decrypt(encryptedData: string, purpose: string = CryptoPurpose.Default): string {
  const secrets = getSecrets();
  // Current HKDF keys first (primary, then rotations), then legacy SHA256
  // keys so rows written before the HKDF migration still decrypt.
  for (const secret of secrets) {
    try {
      return tryDecryptWith(deriveKey(secret, purpose), encryptedData);
    } catch {
      // try next
    }
  }
  for (const secret of secrets) {
    try {
      return tryDecryptWith(legacyKey(secret, purpose), encryptedData);
    } catch {
      // try next
    }
  }
  throw new Error('Failed to decrypt data with any available key');
}
