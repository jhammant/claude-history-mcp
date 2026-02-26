/**
 * CLI commands for federation management.
 *
 * Usage:
 *   claude-history-mcp federation enable      — opt-in to community sharing
 *   claude-history-mcp federation disable     — opt-out
 *   claude-history-mcp federation status      — show what you're sharing, stats
 *   claude-history-mcp federation contribute  — manual push of patterns
 *   claude-history-mcp federation pull        — pull latest community patterns
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { FederationClient } from '../federation/federation-client.js';
const CONFIG_DIR = join(homedir(), '.claude-history-mcp');
const STATE_FILE = join(CONFIG_DIR, 'federation.json');
async function loadState() {
    try {
        const raw = await readFile(STATE_FILE, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return {
            enabled: false,
            hubUrl: process.env.CLAUDE_HISTORY_FEDERATION_URL || 'https://api.claude-history.dev/api/federation',
            lastContributed: null,
            lastPulled: null,
            patternsContributed: 0,
            patternsPulled: 0,
        };
    }
}
async function saveState(state) {
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}
export async function federationCommand(args) {
    const subcommand = args[0];
    switch (subcommand) {
        case 'enable':
            return handleEnable();
        case 'disable':
            return handleDisable();
        case 'status':
            return handleStatus();
        case 'contribute':
            return handleContribute();
        case 'pull':
            return handlePull();
        default:
            console.log(`
Federation — Community Knowledge Sharing (opt-in)

Usage:
  claude-history-mcp federation enable      Opt-in to community sharing
  claude-history-mcp federation disable     Opt-out of community sharing
  claude-history-mcp federation status      Show federation status and stats
  claude-history-mcp federation contribute  Push anonymous patterns to community
  claude-history-mcp federation pull        Pull latest community patterns

Environment variables:
  CLAUDE_HISTORY_FEDERATION_ENABLED   Set to "true" to enable (default: false)
  CLAUDE_HISTORY_FEDERATION_URL       Hub URL (default: https://api.claude-history.dev/api/federation)
  CLAUDE_HISTORY_FEDERATION_SALT      Salt for anonymous hashing

Privacy:
  • Only anonymised, generalised patterns are shared — never code, names, or paths
  • Patterns require k-anonymity (3+ independent sessions) before contribution
  • All identifiers are stripped and hashed before transmission
  • You can disable at any time
`);
    }
}
async function handleEnable() {
    const state = await loadState();
    state.enabled = true;
    await saveState(state);
    console.log('✅ Federation enabled — anonymous patterns will be shared with the community.');
    console.log('');
    console.log('What gets shared:');
    console.log('  • Generalised solution approaches (no code, no names, no paths)');
    console.log('  • Error type → fix patterns (stack traces stripped)');
    console.log('  • Technology categories and tags only');
    console.log('');
    console.log('What NEVER gets shared:');
    console.log('  • Source code, file paths, variable names');
    console.log('  • Project names, company names, person names');
    console.log('  • Specific values, secrets, credentials');
    console.log('  • Anything not seen in 3+ independent sessions');
    console.log('');
    console.log('Run `claude-history-mcp federation status` to see details.');
}
async function handleDisable() {
    const state = await loadState();
    state.enabled = false;
    await saveState(state);
    console.log('🔒 Federation disabled — no patterns will be shared.');
}
async function handleStatus() {
    const state = await loadState();
    console.log(`Federation Status`);
    console.log(`─────────────────`);
    console.log(`  Enabled:              ${state.enabled ? '✅ Yes' : '❌ No'}`);
    console.log(`  Hub URL:              ${state.hubUrl}`);
    console.log(`  Patterns contributed: ${state.patternsContributed}`);
    console.log(`  Patterns pulled:      ${state.patternsPulled}`);
    console.log(`  Last contributed:     ${state.lastContributed ? new Date(state.lastContributed).toISOString() : 'Never'}`);
    console.log(`  Last pulled:          ${state.lastPulled ? new Date(state.lastPulled).toISOString() : 'Never'}`);
    if (state.enabled) {
        try {
            const client = new FederationClient({ enabled: true, hubUrl: state.hubUrl });
            const stats = await client.getStats();
            console.log('');
            console.log(`Community Stats`);
            console.log(`───────────────`);
            console.log(`  Total patterns:       ${stats.totalPatterns}`);
            console.log(`  Total contributors:   ${stats.totalContributors}`);
            if (stats.topCategories.length > 0) {
                console.log(`  Top categories:`);
                for (const cat of stats.topCategories.slice(0, 5)) {
                    console.log(`    ${cat.category}: ${cat.count} patterns`);
                }
            }
        }
        catch (error) {
            console.log('');
            console.log(`⚠️  Could not reach federation hub: ${error.message}`);
        }
    }
}
async function handleContribute() {
    const state = await loadState();
    if (!state.enabled) {
        console.log('❌ Federation is disabled. Run `claude-history-mcp federation enable` first.');
        return;
    }
    console.log('🔄 Scanning local knowledge base for contributable patterns...');
    console.log('');
    console.log('ℹ️  This command scans your local knowledge entries, applies privacy filters,');
    console.log('   checks k-anonymity (3+ sessions), and submits anonymous patterns.');
    console.log('');
    // Note: In a full implementation, this would load from the local SQLite knowledge DB,
    // run filterBatch(), and submit via the federation client. The integration point
    // depends on where the knowledge entries are stored in the MCP.
    console.log('⏳ Integration with local knowledge store pending — will connect to MCP knowledge database.');
    console.log('   Patterns will be filtered through the privacy filter before submission.');
}
async function handlePull() {
    const state = await loadState();
    if (!state.enabled) {
        console.log('❌ Federation is disabled. Run `claude-history-mcp federation enable` first.');
        return;
    }
    console.log('🔄 Pulling latest community patterns...');
    try {
        const client = new FederationClient({ enabled: true, hubUrl: state.hubUrl });
        const result = await client.getPatterns({ limit: 50 });
        state.lastPulled = Date.now();
        state.patternsPulled += result.patterns.length;
        await saveState(state);
        console.log(`✅ Pulled ${result.patterns.length} patterns (${result.total} total available)`);
        if (result.patterns.length > 0) {
            console.log('');
            console.log('Sample patterns:');
            for (const p of result.patterns.slice(0, 5)) {
                console.log(`  [${p.type}] ${p.category} — ${p.approach.slice(0, 80)}...`);
                console.log(`    👥 ${p.contributorCount} contributors | ⭐ ${(p.effectiveness * 100).toFixed(0)}% effective`);
            }
        }
    }
    catch (error) {
        console.log(`❌ Failed to pull patterns: ${error.message}`);
    }
}
//# sourceMappingURL=federation.js.map