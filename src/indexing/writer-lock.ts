/**
 * One index writer at a time. Every Claude Code and Codex session starts its own copy
 * of this server; each keeps its in-memory index fresh, but only the lock holder writes
 * the (100+ MB) index to disk. A holder that has exited is replaced at the next save.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { CONFIG } from "../config.js";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function claimWriterLock(lockFile = `${CONFIG.indexFile}.lock`): boolean {
  const dir = dirname(lockFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(lockFile, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    // Held now, or held by a server that has exited
  }
  try {
    const holder = Number(readFileSync(lockFile, "utf-8"));
    if (holder === process.pid) return true;
    if (holder > 0 && isAlive(holder)) return false;
    writeFileSync(lockFile, String(process.pid));
    return true;
  } catch {
    return false;
  }
}
