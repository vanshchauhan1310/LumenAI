import crypto from "node:crypto";

/**
 * Symmetric secret encryption for storing Tableau PATs and LLM API keys at rest.
 *
 * Backed today by AES-256-GCM with a key from ENCRYPTION_KEY. To swap in a real
 * KMS later, replace the body of encrypt()/decrypt() with calls to the KMS
 * client — callers only depend on this module's function signatures, not on
 * how the key is managed.
 */

const ALGORITHM = "aes-256-gcm";

function getKey(): Buffer {
  const keyB64 = process.env.ENCRYPTION_KEY;
  if (!keyB64) {
    throw new Error("ENCRYPTION_KEY env var is not set");
  }
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must decode to exactly 32 bytes (base64-encoded)");
  }
  return key;
}

/** Encrypts a plaintext secret. Returns an opaque base64 string safe to store in a DB column. */
export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

/** Decrypts a value produced by encryptSecret(). Throws if the value has been tampered with. */
export function decryptSecret(stored: string): string {
  const key = getKey();
  const raw = Buffer.from(stored, "base64");
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}

/** Redacts a secret for safe inclusion in logs/errors — never log raw keys/tokens. */
export function redact(_secret: string): string {
  return "[REDACTED]";
}
