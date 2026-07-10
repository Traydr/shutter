const textEncoder = new TextEncoder();

export function encodeUtf8(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(textEncoder.encode(value));
}

export function frameStrings(values: readonly string[]): Uint8Array<ArrayBuffer> {
  const encoded = values.map(encodeUtf8);
  const length = encoded.reduce((total, value) => total + 4 + value.byteLength, 0);
  const output = new Uint8Array(length);
  const view = new DataView(output.buffer);
  let offset = 0;

  for (const value of encoded) {
    view.setUint32(offset, value.byteLength, false);
    offset += 4;
    output.set(value, offset);
    offset += value.byteLength;
  }

  return output;
}

export function copyBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(value);
}
