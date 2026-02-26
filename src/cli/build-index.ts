#!/usr/bin/env node

/**
 * CLI: Build the full search index from all conversation history.
 * Usage: npx tsx src/cli/build-index.ts
 */

import { IndexManager } from "../indexing/index-manager.js";
import { enumerateSessionFiles } from "../parsers/session-parser.js";
import { KnowledgeStore } from "../knowledge/knowledge-store.js";

async function main(): Promise<void> {
  console.log("Claude History MCP — Building Index\n");

  // Show what we're indexing
  const files = enumerateSessionFiles();
  const projects = new Set(files.map((f) => f.projectDir));
  console.log(`Found ${files.length} session files across ${projects.size} projects\n`);

  // Build index
  const indexManager = new IndexManager();
  console.log("Building search index...");
  const startTime = Date.now();
  const stats = await indexManager.buildFullIndex();
  const elapsed = Date.now() - startTime;

  console.log(`  Indexed ${stats.sessions} sessions into ${stats.chunks} chunks`);
  console.log(`  Build time: ${elapsed}ms`);

  // Save
  console.log("Saving index to disk...");
  await indexManager.save();

  // Show stats
  const indexStats = indexManager.getStats();
  console.log(`\nIndex Statistics:`);
  console.log(`  Documents: ${indexStats.documents}`);
  console.log(`  Sessions: ${indexStats.sessions}`);
  console.log(`  Projects: ${indexStats.projects}`);
  console.log(`  Vocabulary: ${indexStats.vocabulary} terms`);

  console.log("\nDone! Index saved to ~/.claude-history-mcp/");
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
