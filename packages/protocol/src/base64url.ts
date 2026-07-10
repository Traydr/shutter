import { ProtocolError } from "./errors.js";

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!BASE64URL_PATTERN.test(value)) {
    throw new ProtocolError("capability_malformed", "binary components must be unpadded base64url");
  }

  const paddingLength = (4 - (value.length % 4)) % 4;
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat(paddingLength);

  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new ProtocolError("capability_malformed", "binary component is not valid base64url");
  }

  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }

  if (encodeBase64Url(output) !== value) {
    throw new ProtocolError("capability_malformed", "binary component is not canonical base64url");
  }

  return output;
}
