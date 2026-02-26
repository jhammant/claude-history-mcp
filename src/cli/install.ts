#!/usr/bin/env node

/**
 * CLI: Install the session-start hook and skill.
 * Usage: npx tsx src/cli/install.ts
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { CONFIG } from "../config.js";

function main(): void {
  console.log("Claude History MCP — Install\n");

  installHook();
  installSkill();
  ensureDataDir();

  console.log("\nInstallation complete!");
  console.log("Next steps:");
  console.log("  1. Run 'npm run build-index' to build the initial search index");
  console.log("  2. Add the MCP server to your Claude Code config:");
  console.log('     claude mcp add claude-history -- node "' + resolve("dist/index.js") + '"');
}

function installHook(): void {
  console.log("Installing session-start hook...");

  const settingsFile = CONFIG.settingsFile;
  let settings: Record<string, unknown> = {};

  if (existsSync(settingsFile)) {
    try {
      settings = JSON.parse(readFileSync(settingsFile, "utf-8"));
    } catch {
      console.error("  Warning: could not parse existing settings.json");
    }
  }

  const hooks = (settings.hooks || {}) as Record<string, unknown[]>;
  const sessionStartHooks = (hooks.SessionStart || []) as Array<{
    hooks: Array<{ type: string; command: string }>;
  }>;

  // Check if already installed
  const hookCommand = `node "${resolve("dist/hooks/session-start-hook.js")}"`;
  const alreadyInstalled = sessionStartHooks.some((entry) =>
    entry.hooks?.some((h) => h.command?.includes("session-start-hook"))
  );

  if (alreadyInstalled) {
    console.log("  Session-start hook already installed.");
  } else {
    sessionStartHooks.push({
      hooks: [{ type: "command", command: hookCommand }],
    });
    hooks.SessionStart = sessionStartHooks;
    settings.hooks = hooks;
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
    console.log("  Session-start hook installed in ~/.claude/settings.json");
  }
}

function installSkill(): void {
  console.log("Installing /claude-history skill...");

  const commandsDir = join(CONFIG.claudeDir, "commands");
  if (!existsSync(commandsDir)) mkdirSync(commandsDir, { recursive: true });

  const source = resolve("commands/claude-history.md");
  const dest = join(commandsDir, "claude-history.md");

  if (existsSync(source)) {
    copyFileSync(source, dest);
    console.log("  Skill installed at ~/.claude/commands/claude-history.md");
  } else {
    console.log("  Warning: commands/claude-history.md not found, skipping skill install.");
  }
}

function ensureDataDir(): void {
  const dirs = [CONFIG.dataDir, CONFIG.summariesDir];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
  console.log("Data directory ensured at ~/.claude-history-mcp/");
}

main();
