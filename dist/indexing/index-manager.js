/**
 * Orchestrate indexing: parse sessions, chunk text, build BM25 + TF-IDF indexes.
 * Handles persistence via msgpack and incremental updates.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { CONFIG } from "../config.js";
import { enumerateSessionFiles, parseSessionFile, } from "../parsers/session-parser.js";
import { tokenize } from "./tokenizer.js";
import { BM25Index } from "./bm25.js";
import { TFIDFIndex } from "./tfidf.js";
import { DocumentStore, } from "./document-store.js";
export class IndexManager {
    bm25;
    tfidf;
    documents;
    meta;
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
        return { added, updated, unchanged };
    }
    /**
     * Index a single session file.
     */
    indexFile(file) {
        const session = parseSessionFile(file.filePath, file.projectDir);
        if (!session)
            return;
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
    }
    /**
     * Remove a session from all indexes.
     */
    removeSession(sessionId) {
        const docs = this.documents.getSessionDocuments(sessionId);
        for (const doc of docs) {
            this.bm25.removeDocument(doc.id);
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
                        return;
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
     * Save index to disk using msgpack.
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
            const { pack } = await import("msgpackr");
            const packed = pack(data);
            writeFileSync(CONFIG.indexFile, packed);
        }
        catch {
            // Fallback to JSON if msgpack fails
            writeFileSync(CONFIG.indexFile.replace(".msgpack", ".json"), JSON.stringify(data));
        }
    }
    /**
     * Load index from disk.
     */
    async load() {
        // Try msgpack first
        if (existsSync(CONFIG.indexFile)) {
            try {
                const { unpack } = await import("msgpackr");
                const raw = readFileSync(CONFIG.indexFile);
                const data = unpack(raw);
                this.restoreFromSerialized(data);
                return true;
            }
            catch {
                // Fall through to JSON
            }
        }
        // Try JSON fallback
        const jsonFile = CONFIG.indexFile.replace(".msgpack", ".json");
        if (existsSync(jsonFile)) {
            try {
                const raw = readFileSync(jsonFile, "utf-8");
                const data = JSON.parse(raw);
                this.restoreFromSerialized(data);
                return true;
            }
            catch {
                return false;
            }
        }
        return false;
    }
    restoreFromSerialized(data) {
        this.bm25 = BM25Index.deserialize(data.bm25);
        this.tfidf = TFIDFIndex.deserialize(data.tfidf);
        this.documents = DocumentStore.deserialize(data.documents);
        this.meta = data.meta;
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