export interface Truncated {
  text: string;
  truncated: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Keeps at most `maxBytes` of UTF-8 from the start of `text`. */
export function keepHead(text: string, maxBytes: number): Truncated {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };

  let end = maxBytes;
  // Don't cut a multi-byte character in half: back up to its lead byte.
  while (end > 0 && isContinuationByte(bytes[end])) end--;
  return { text: decoder.decode(bytes.subarray(0, end)), truncated: true };
}

/**
 * Keeps at most `maxBytes` of UTF-8 from the end of `text`. Used for process
 * output, where the useful part (failures, summaries) is usually at the end.
 */
export function keepTail(text: string, maxBytes: number): Truncated {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };

  let start = bytes.length - maxBytes;
  while (start < bytes.length && isContinuationByte(bytes[start])) start++;
  return { text: decoder.decode(bytes.subarray(start)), truncated: true };
}

function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0b1100_0000) === 0b1000_0000;
}
