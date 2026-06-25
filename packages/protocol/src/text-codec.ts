const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeTextCommand(value: string): Uint8Array {
  return encoder.encode(value);
}

export function decodeTextCommand(value: Uint8Array): string {
  return decoder.decode(value);
}
