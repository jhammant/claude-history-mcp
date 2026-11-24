import { closeSync, openSync, readSync, readdirSync, statSync } from "fs";
export function readDir(dir) {
    try {
        return readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return [];
    }
}
export function statFile(path, base) {
    try {
        const stat = statSync(path);
        if (!stat.isFile())
            return null;
        return { ...base, path, size: stat.size, mtimeMs: Math.floor(stat.mtimeMs), ino: stat.ino };
    }
    catch {
        return null; // deleted between readdir and stat
    }
}
const FIRST_LINE_MAX = 4 << 20;
/** The first line of a file, up to a cap (a session_meta with its base instructions is large). */
export function readFirstLine(path) {
    let fd;
    try {
        fd = openSync(path, "r");
    }
    catch {
        return null;
    }
    try {
        const chunks = [];
        let total = 0;
        let position = 0;
        while (total < FIRST_LINE_MAX) {
            const chunk = Buffer.allocUnsafe(64 << 10);
            const read = readSync(fd, chunk, 0, chunk.length, position);
            if (read === 0)
                break;
            position += read;
            const newline = chunk.subarray(0, read).indexOf(0x0a);
            if (newline !== -1) {
                chunks.push(chunk.subarray(0, newline));
                return Buffer.concat(chunks).toString("utf8");
            }
            chunks.push(chunk.subarray(0, read));
            total += read;
        }
        return total < FIRST_LINE_MAX ? Buffer.concat(chunks).toString("utf8") : null;
    }
    catch {
        return null;
    }
    finally {
        closeSync(fd);
    }
}
/**
 * The first `count` lines of a file, each read with readFirstLine's cap: a line whose
 * newline is not found within FIRST_LINE_MAX bytes (plus the chunk that crosses it) ends
 * the list, and it and the lines after it are left out. A last line with no newline yet is
 * included.
 */
export function readHeadLines(path, count) {
    let fd;
    try {
        fd = openSync(path, "r");
    }
    catch {
        return [];
    }
    const lines = [];
    try {
        let chunks = [];
        let total = 0;
        let position = 0;
        while (lines.length < count && total < FIRST_LINE_MAX) {
            const chunk = Buffer.allocUnsafe(64 << 10);
            const read = readSync(fd, chunk, 0, chunk.length, position);
            if (read === 0) {
                if (total > 0)
                    lines.push(Buffer.concat(chunks).toString("utf8"));
                break;
            }
            const data = chunk.subarray(0, read);
            const newline = data.indexOf(0x0a);
            if (newline === -1) {
                chunks.push(data);
                total += read;
                position += read;
                continue;
            }
            chunks.push(data.subarray(0, newline));
            lines.push(Buffer.concat(chunks).toString("utf8"));
            chunks = [];
            total = 0;
            position += newline + 1;
        }
        return lines;
    }
    catch {
        return lines;
    }
    finally {
        closeSync(fd);
    }
}
//# sourceMappingURL=fs-util.js.map