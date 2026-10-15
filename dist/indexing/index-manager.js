/**
 * Orchestrate indexing: parse sessions, chunk text, build BM25 + TF-IDF indexes.
 * Handles persistence via msgpack and incremental updates.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, } from "fs";
import { basename, dirname } from "path";
import { CONFIG } from "../config.js";
import { enumerateSessionFiles, parseSessionFile, } from "../parsers/session-parser.js";
import { tokenize } from "./tokenizer.js";
import { BM25Index } from "./bm25.js";
import { TFIDFIndex } from "./tfidf.js";
import { DocumentStore, } from "./document-store.js";
/**
 * msgpack with 32-bit map headers. The default 16-bit headers can't hold a vocabulary
 * past 65,535 terms: pack() threw, every save fell back to JSON, and load() kept
 * reading the last msgpack that had fitted (27 sessions, months old), so each new
 * server re-indexed months of history at start-up.
 */
async function packr() {
    const { Packr } = await import("msgpackr");
    return new Packr({ variableMapSize: true });
}
/** The module-level unpack reads both this format and files the old default pack() wrote. */
async function unpackIndex(raw) {
    const { unpack } = await import("msgpackr");
    return unpack(raw);
}
function jsonIndexFile() {
    return CONFIG.indexFile.replace(".msgpack", ".json");
}
/** Write via a temp file and rename, so a reader (or another server) never sees half an index. */
function writeAtomically(path, data) {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, path);
}
export class IndexManager {
    bm25;
    tfidf;
    documents;
    meta;
    dirty = false;
    /** True when the in-memory index has changes that are not on disk yet. */
    get isDirty() {
        return this.dirty;
    }
    constructor() {
        this.bm25 = new BM25Index();
        this.tfidf = new TFIDFIndex();
        this.documents = new DocumentStore();
        this.meta = {
            lastIndexed: {},
            buildTime: 0,
            version: 1,
        };
    }
    /**
     * Build or rebuild the full index from scratch.
     */
    async buildFullIndex() {
        const startTime = Date.now();
        const files = enumerateSessionFiles();
        // Reset everything
        this.bm25 = new BM25Index();
        this.tfidf = new TFIDFIndex();
        this.documents = new DocumentStore();
        this.meta = {
            lastIndexed: {},
            buildTime: 0,
            version: 1,
        };
        let sessionCount = 0;
        for (const file of files) {
            this.indexFile(file);
            sessionCount++;
        }
        this.meta.buildTime = Date.now() - startTime;
        this.dirty = true;
        return {
            sessions: sessionCount,
            chunks: this.documents.getDocumentCount(),
        };
    }
    /**
     * Incrementally update: only re-index files that changed since last index.
     */
    async incrementalUpdate() {
        const files = enumerateSessionFiles();
        let added = 0;
        let updated = 0;
        let unchanged = 0;
        for (const file of files) {
            const lastMtime = this.meta.lastIndexed[file.filePath];
            if (lastMtime === undefined) {
                // New file
                this.indexFile(file);
                added++;
            }
            else if (file.mtime > lastMtime) {
                // Updated file — remove old docs and re-index
                this.removeSession(file.sessionId);
                this.indexFile(file);
                updated++;
            }
            else {
                unchanged++;
            }
        }
        if (added + updated > 0)
            this.dirty = true;
        return { added, updated, unchanged };
    }
    /**
     * Re-index one session file if it changed since it was last indexed. Returns the
     * parsed session when it was re-indexed (so callers can reuse it), else null.
     */
    updateFile(filePath) {
        let stat;
        try {
            stat = statSync(filePath);
        }
        catch {
            return null;
        }
        if (!stat.isFile())
            return null;
        const lastMtime = this.meta.lastIndexed[filePath];
        if (lastMtime !== undefined && stat.mtimeMs <= lastMtime)
            return null;
        const sessionId = basename(filePath, ".jsonl");
        if (lastMtime !== undefined)
            this.removeSession(sessionId);
        return this.indexFile({
            filePath,
            projectDir: basename(dirname(filePath)),
            sessionId,
            mtime: stat.mtimeMs,
            size: stat.size,
        });
    }
    /** Drop the in-memory index (it can be several GB); load() brings it back. */
    unload() {
        this.bm25 = new BM25Index();
        this.tfidf = new TFIDFIndex();
        this.documents = new DocumentStore();
        this.meta = { lastIndexed: {}, buildTime: 0, version: 1 };
        this.dirty = false;
    }
    /**
     * Index a single session file.
     */
    indexFile(file) {
        const session = parseSessionFile(file.filePath, file.projectDir);
        if (!session)
            return null;
        const chunks = this.chunkSession(session);
        for (const chunk of chunks) {
            const tokens = tokenize(chunk.text, { includeBigrams: true });
            const docId = this.documents.addDocument(chunk.text, tokens.length, {
                sessionId: session.sessionId,
                project: session.project,
                role: chunk.role,
                timestamp: chunk.timestamp,
                toolNames: chunk.toolNames,
                messageIndex: chunk.messageIndex,
            });
            this.bm25.addDocument(docId, tokens);
            this.tfidf.addDocument(docId, tokens);
        }
        this.meta.lastIndexed[file.filePath] = file.mtime;
        this.dirty = true;
        return session;
    }
    /**
     * Remove a session from all indexes.
     */
    removeSession(sessionId) {
        const docs = this.documents.getSessionDocuments(sessionId);
        for (const doc of docs) {
            // Same tokenizer as indexFile, so these are exactly the terms the document was added under
            this.bm25.removeDocument(doc.id, new Set(tokenize(doc.text, { includeBigrams: true })));
            this.tfidf.removeDocument(doc.id);
        }
        this.documents.removeSession(sessionId);
    }
    /**
     * Chunk a session into indexable pieces.
     * Strategy: group consecutive same-role messages, split long chunks.
     */
    chunkSession(session) {
        const chunks = [];
        const { chunkSize, maxChunksPerSession } = CONFIG.indexing;
        let currentText = "";
        let currentRole = null;
        let currentTimestamp = 0;
        let currentToolNames = [];
        let currentMessageIndex = 0;
        const flush = () => {
            if (currentText.trim() && currentRole) {
                // Split if too long
                const words = currentText.split(/\s+/);
                for (let i = 0; i < words.length; i += chunkSize) {
                    if (chunks.length >= maxChunksPerSession)
                        break;
                    chunks.push({
                        text: words.slice(i, i + chunkSize).join(" "),
                        role: currentRole,
                        timestamp: currentTimestamp,
                        toolNames: [...currentToolNames],
                        messageIndex: currentMessageIndex,
                    });
                }
            }
            currentText = "";
            currentRole = null;
            currentToolNames = [];
        };
        for (let i = 0; i < session.messages.length; i++) {
            if (chunks.length >= maxChunksPerSession)
                break;
            const msg = session.messages[i];
            // Group user+assistant exchanges together for better context
            if (currentRole && currentRole !== msg.role) {
                // If switching from user to assistant, keep them together
                if (currentRole === "user" && msg.role === "assistant") {
                    currentRole = "mixed";
                }
                else {
                    flush();
                }
            }
            if (!currentRole) {
                currentRole = msg.role;
                currentTimestamp = msg.timestamp
                    ? new Date(msg.timestamp).getTime() || 0
                    : 0;
                currentMessageIndex = i;
            }
            currentText += (currentText ? "\n" : "") + msg.text;
            if (msg.toolNames.length > 0) {
                currentToolNames.push(...msg.toolNames);
            }
            if (msg.toolInputSnippets.length > 0) {
                currentText += " " + msg.toolInputSnippets.join(" ");
            }
            // Flush if chunk is getting large
            const wordCount = currentText.split(/\s+/).length;
            if (wordCount >= chunkSize * 1.5) {
                flush();
            }
        }
        flush();
        return chunks;
    }
    /**
     * Save index to disk using msgpack (JSON if msgpack fails).
     */
    async save() {
        const dir = dirname(CONFIG.indexFile);
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true });
        const data = {
            bm25: this.bm25.serialize(),
            tfidf: this.tfidf.serialize(),
            documents: this.documents.serialize(),
            meta: this.meta,
        };
        try {
            writeAtomically(CONFIG.indexFile, (await packr()).pack(data));
            if (existsSync(jsonIndexFile()))
                unlinkSync(jsonIndexFile());
        }
        catch (error) {
            console.error(`claude-history-mcp: msgpack save failed, writing JSON instead: ${error.message}`);
            writeAtomically(jsonIndexFile(), JSON.stringify(data));
        }
        this.dirty = false;
    }
    /**
     * Load index from disk: the newer of the msgpack and JSON files, so a stale file in
     * one format never shadows a fresh one in the other.
     */
    async load() {
        const candidates = [CONFIG.indexFile, jsonIndexFile()]
            .filter((file) => existsSync(file))
            .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
        for (const file of candidates) {
            try {
                const data = (file.endsWith(".json")
                    ? JSON.parse(readFileSync(file, "utf-8"))
                    : await unpackIndex(readFileSync(file)));
                this.restoreFromSerialized(data);
                return true;
            }
            catch {
                // Try the other format
            }
        }
        return false;
    }
    restoreFromSerialized(data) {
        this.bm25 = BM25Index.deserialize(data.bm25);
        this.tfidf = TFIDFIndex.deserialize(data.tfidf);
        this.documents = DocumentStore.deserialize(data.documents);
        this.meta = data.meta;
        this.dirty = false;
    }
    /**
     * Get index statistics.
     */
    getStats() {
        return {
            documents: this.documents.getDocumentCount(),
            sessions: this.documents.getSessionIds().size,
            projects: this.documents.getProjects().size,
            vocabulary: this.bm25.getVocabularySize(),
            buildTimeMs: this.meta.buildTime,
        };
    }
}
//# sourceMappingURL=index-manager.js.map