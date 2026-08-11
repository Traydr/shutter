import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const HEX_KEY_PATTERN = /^[0-9a-fA-F]{64}$/u;
const BASE64URL_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface SealedCapabilityKey {
  nonce: string;
  ciphertext: string;
}

export class EncryptionConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionConfigurationError";
  }
}

function decodeEncryptionKey(value: string): Buffer {
  const key = HEX_KEY_PATTERN.test(value)
    ? Buffer.from(value, "hex")
    : BASE64URL_KEY_PATTERN.test(value)
      ? Buffer.from(value, "base64url")
      : Buffer.alloc(0);
  if (key.byteLength !== 32) {
    throw new EncryptionConfigurationError(
      "SHUTTER_ENCRYPTION_KEY must be 32 bytes encoded as hex or base64url",
    );
  }
  return key;
}

function additionalData(spaceId: string, keyId: string): Buffer {
  const buffers: Buffer[] = [];
  for (const part of ["v1", spaceId, keyId]) {
    const bytes = Buffer.from(part, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.byteLength);
    buffers.push(length, bytes);
  }
  return Buffer.concat(buffers);
}

export class CapabilityKeyEncryption {
  readonly #key: Buffer;

  constructor(encodedKey: string) {
    this.#key = decodeEncryptionKey(encodedKey);
  }

  seal(spaceId: string, keyId: string, plaintext: Uint8Array): SealedCapabilityKey {
    if (plaintext.byteLength !== 32) {
      throw new EncryptionConfigurationError("a Capability Key must contain 32 bytes");
    }
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(additionalData(spaceId, keyId));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return { nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url") };
  }

  open(spaceId: string, keyId: string, sealed: SealedCapabilityKey): Uint8Array {
    const nonce = Buffer.from(sealed.nonce, "base64url");
    const ciphertext = Buffer.from(sealed.ciphertext, "base64url");
    if (nonce.byteLength !== NONCE_BYTES || ciphertext.byteLength !== 32 + TAG_BYTES) {
      throw new EncryptionConfigurationError("the sealed Capability Key has an invalid envelope");
    }
    const tag = ciphertext.subarray(ciphertext.byteLength - TAG_BYTES);
    const encrypted = ciphertext.subarray(0, ciphertext.byteLength - TAG_BYTES);
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key, nonce);
      decipher.setAAD(additionalData(spaceId, keyId));
      decipher.setAuthTag(tag);
      return Uint8Array.from(Buffer.concat([decipher.update(encrypted), decipher.final()]));
    } catch {
      throw new EncryptionConfigurationError("the sealed Capability Key failed authentication");
    }
  }
}
