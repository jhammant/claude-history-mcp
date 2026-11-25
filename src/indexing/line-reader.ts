/**
 * Read complete JSONL lines from a byte offset, in bounded batches, without loading
 * the whole file. A trailing line with no newline yet is left for the next read.
 */

import { readSync } from "fs";

const CHUNK = 1 << 20;
const NEWLINE = 0x0a;

export interface LineBatch {
  lines: Buffer[];
  /** Byte offset in the file at which each of `lines` starts. */
  starts: number[];
  /** Offset just past the last complete line returned (== start when none). */
  end: number;
  /** True when the read reached the end of the file (an unfinished last line stays unread). */
  eof: boolean;
}

/**
 * Read from `start` until at least `maxBytes` of complete lines have been collected or
 * the file ends. A single line longer than `maxBytes` is still returned whole.
 */
export function readLines(fd: number, start: number, maxBytes: number): LineBatch {
  const lines: Buffer[] = [];
  const starts: number[] = [];
  let position = start;
  let end = start;
  // Pieces of a line that spans chunk boundaries (kept as a list: no quadratic concat).
  let partial: Buffer[] = [];

  while (end - start < maxBytes) {
    const chunk = Buffer.allocUnsafe(CHUNK);
    const read = readSync(fd, chunk, 0, CHUNK, position);
    if (read === 0) return { lines, starts, end, eof: true };
    position += read;
    const data = chunk.subarray(0, read);
    let lineStart = 0;
    let newline = data.indexOf(NEWLINE);
    while (newline !== -1) {
      const piece = data.subarray(lineStart, newline);
      const line = partial.length ? Buffer.concat([...partial, piece]) : piece;
      if (line.length) {
        lines.push(line);
        starts.push(end);
      }
      end += line.length + 1;
      partial = [];
      lineStart = newline + 1;
      newline = data.indexOf(NEWLINE, lineStart);
    }
    if (lineStart < data.length) partial.push(data.subarray(lineStart));
  }
  return { lines, starts, end, eof: false };
}
