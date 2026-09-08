/**
 * Client-side Key Vault using Web Crypto API.
 * Encrypts user API keys using AES-GCM with a key derived via PBKDF2 from a user-provided password.
 */

export interface EncryptedKey {
  ciphertext: string;
  salt: string;
  iv: string;
}

function bufferToBase64(buffer: Uint8Array): string {
  let binary = '';
  const len = buffer.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(buffer[i]);
  }
  return btoa(binary);
}

function base64ToBuffer(base64: string): Uint8Array {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const getDerivedKey = async (password: string, salt: Uint8Array): Promise<CryptoKey> => {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits", "deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: 600000,
      hash: "SHA-256"
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    // Non-extractable: the raw key must never leave WebCrypto — encrypt and
    // decrypt are the only permitted operations.
    false,
    ["encrypt", "decrypt"]
  );
};

export const encryptKey = async (apiKey: string, password: string): Promise<EncryptedKey> => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await getDerivedKey(password, salt);

  const enc = new TextEncoder();
  const encryptedContent = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    enc.encode(apiKey)
  );

  const encryptedBytes = new Uint8Array(encryptedContent);
  return {
    ciphertext: bufferToBase64(encryptedBytes),
    salt: bufferToBase64(salt),
    iv: bufferToBase64(iv)
  };
};

export const decryptKey = async (encryptedObj: EncryptedKey, password: string): Promise<string | null> => {
  try {
    const salt = base64ToBuffer(encryptedObj.salt);
    const iv = base64ToBuffer(encryptedObj.iv);
    const ciphertext = base64ToBuffer(encryptedObj.ciphertext);

    const key = await getDerivedKey(password, salt);

    const decryptedContent = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      ciphertext as BufferSource
    );

    const dec = new TextDecoder();
    return dec.decode(decryptedContent);
  } catch (error) {
    console.error("Failed to decrypt key. Incorrect password or corrupted data.", error);
    return null;
  }
};
