/**
 * Read complete JSONL lines from a byte offset, in bounded batches, without loading
 * the whole file. A trailing line with no newline yet is left for the next read.
 */
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
export declare function readLines(fd: number, start: number, maxBytes: number): LineBatch;
//# sourceMappingURL=line-reader.d.ts.map