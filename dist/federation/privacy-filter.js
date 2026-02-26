/**
 * Privacy Filter — transforms private knowledge entries into anonymous community patterns.
 *
 * This is the core privacy gate. When in doubt, strip MORE data, not less.
 * No code, no names, no paths, no specific values ever leave the machine.
 */
import { createHash } from 'crypto';
const DEFAULT_CONFIG = {
    salt: process.env.CLAUDE_HISTORY_FEDERATION_SALT || 'claude-history-federation-default-salt',
    kAnonymityThreshold: 3,
};
// ── Stripping patterns ──────────────────────────────────────────────────────
const FILE_PATH_RE = /(?:\/[\w.\-]+){2,}(?:\.\w+)?/g;
const WINDOWS_PATH_RE = /[A-Z]:\\(?:[\w.\- ]+\\)+[\w.\-]+/gi;
const FUNC_NAME_RE = /\b(?:function|const|let|var|class|def|fn)\s+([A-Za-z_]\w+)/g;
const CAMEL_CASE_IDENT_RE = /\b[a-z]+(?:[A-Z][a-z]+){2,}\b/g; // 3+ humps likely a custom name
const IMPORT_RE = /(?:import|require|from)\s+['"][^'"]+['"]/g;
const EMAIL_RE = /[\w.+-]+@[\w.-]+\.\w+/g;
const IP_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?\b/g;
const URL_RE = /https?:\/\/[^\s)>"']+/g;
const STACK_TRACE_RE = /^\s+at\s+.+$/gm;
const PORT_RE = /\bport\s+\d+\b/gi;
const COST_RE = /\$[\d,.]+(?:\/\w+)?/g;
const SECRET_RE = /(?:key|token|secret|password|api[_-]?key|auth)[=:]\s*['"]?[^\s'"]+/gi;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_HASH_RE = /\b[0-9a-f]{32,}\b/gi;
// Common proper name patterns (basic heuristic — consecutive capitalised words)
const PROPER_NAME_RE = /\b(?:[A-Z][a-z]+\s+){1,3}[A-Z][a-z]+\b/g;
/**
 * Strip all identifying information from text, replacing with generic placeholders.
 */
export function stripIdentifiers(text) {
    let result = text;
    // Order matters — strip most specific patterns first
    result = result.replace(SECRET_RE, '[REDACTED_SECRET]');
    result = result.replace(EMAIL_RE, '[EMAIL]');
    result = result.replace(URL_RE, '[URL]');
    result = result.replace(WINDOWS_PATH_RE, '[PATH]');
    result = result.replace(FILE_PATH_RE, '[PATH]');
    result = result.replace(IP_RE, '[HOST]');
    result = result.replace(UUID_RE, '[ID]');
    result = result.replace(HEX_HASH_RE, '[HASH]');
    result = result.replace(IMPORT_RE, '[IMPORT]');
    result = result.replace(STACK_TRACE_RE, '  at [STACK_FRAME]');
    result = result.replace(FUNC_NAME_RE, (match, name) => match.replace(name, '[IDENTIFIER]'));
    result = result.replace(CAMEL_CASE_IDENT_RE, '[IDENTIFIER]');
    result = result.replace(PROPER_NAME_RE, '[NAME]');
    result = result.replace(COST_RE, '[COST]');
    result = result.replace(PORT_RE, 'custom port');
    // Collapse multiple consecutive redactions
    result = result.replace(/(\[(?:STACK_FRAME|PATH|IDENTIFIER)\]\s*\n?){3,}/g, '[REDACTED_BLOCK]\n');
    return result.trim();
}
/**
 * Generalise an error message: keep the error type, strip everything specific.
 */
export function generaliseError(errorText) {
    // Extract error type (e.g. "TypeError", "ENOENT", "404 Not Found")
    const errorTypeMatch = errorText.match(/\b((?:[A-Z][a-z]+)+Error|E[A-Z]+|[45]\d{2}\s+\w[\w ]*|\w+Exception)\b/);
    const errorType = errorTypeMatch?.[1] || 'Error';
    // Strip the details but keep the type
    let generalised = stripIdentifiers(errorText);
    // If the result is too long, truncate to error type + first sentence
    if (generalised.length > 200) {
        const firstSentence = generalised.split(/[.!?\n]/)[0]?.trim() || '';
        generalised = firstSentence.length > 200
            ? `${errorType}: [details redacted]`
            : `${errorType}: ${firstSentence}`;
    }
    return generalised;
}
/**
 * Hash a value with SHA-256 + salt for anonymous identification.
 */
export function hashWithSalt(value, salt = DEFAULT_CONFIG.salt) {
    return createHash('sha256').update(`${salt}:${value}`).digest('hex');
}
/**
 * Check k-anonymity: has this pattern been seen in k+ independent sessions?
 */
export function checkKAnonymity(entry, allEntries, k = DEFAULT_CONFIG.kAnonymityThreshold) {
    const normalised = normaliseApproach(entry.summary + ' ' + entry.details);
    const category = entry.tags?.join('/') || 'uncategorised';
    const patternHash = hashWithSalt(`${category}:${normalised}`);
    const uniqueSessions = new Set();
    for (const e of allEntries) {
        const eNormalised = normaliseApproach(e.summary + ' ' + e.details);
        const eCategory = e.tags?.join('/') || 'uncategorised';
        const eHash = hashWithSalt(`${eCategory}:${eNormalised}`);
        if (eHash === patternHash) {
            uniqueSessions.add(e.sessionId);
        }
    }
    return uniqueSessions.size >= k;
}
/**
 * Normalise approach text for deduplication — lowercase, collapse whitespace, strip punctuation.
 */
function normaliseApproach(text) {
    return text
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
/**
 * Transform a private knowledge entry into an anonymous community pattern.
 * Returns null if the entry cannot be safely anonymised or fails k-anonymity.
 */
export function toAnonymousPattern(entry, allEntries, config = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    // K-anonymity gate
    if (!checkKAnonymity(entry, allEntries, cfg.kAnonymityThreshold)) {
        return null;
    }
    // Strip identifiers from summary and details
    const strippedSummary = stripIdentifiers(entry.summary);
    const strippedDetails = entry.type === 'error_fix'
        ? generaliseError(entry.details)
        : stripIdentifiers(entry.details);
    // Build the generalised approach description
    const approach = strippedDetails.length > 0
        ? `${strippedSummary}. ${strippedDetails}`
        : strippedSummary;
    // Final safety check — reject if approach still looks too specific
    if (approach.length < 10)
        return null;
    // Filter tags to only technology-related ones (no custom/project names)
    const safeTags = (entry.tags || []).filter(isTechnologyTag);
    const category = safeTags.length > 0 ? safeTags.slice(0, 2).join('/') : 'general';
    const platform = safeTags.find((t) => PLATFORM_TAGS.has(t.toLowerCase()));
    const patternHash = hashWithSalt(`${category}:${normaliseApproach(approach)}`, cfg.salt);
    return {
        id: patternHash,
        type: entry.type,
        category,
        platform,
        approach,
        tags: safeTags,
        effectiveness: entry.effectiveness ?? 0.5,
        contributorCount: 1,
        firstSeen: entry.createdAt,
        lastSeen: entry.createdAt,
    };
}
// ── Tag validation ──────────────────────────────────────────────────────────
const KNOWN_TECH_TAGS = new Set([
    // Languages
    'typescript', 'javascript', 'python', 'rust', 'go', 'java', 'c', 'cpp', 'csharp',
    'ruby', 'php', 'swift', 'kotlin', 'scala', 'elixir', 'haskell', 'lua', 'perl',
    'r', 'dart', 'zig', 'ocaml', 'clojure',
    // Frameworks
    'react', 'nextjs', 'vue', 'angular', 'svelte', 'express', 'fastify', 'nestjs',
    'django', 'flask', 'fastapi', 'rails', 'spring', 'laravel', 'phoenix', 'actix',
    'gin', 'echo', 'fiber', 'remix', 'nuxt', 'gatsby', 'astro', 'solid',
    // Infrastructure
    'aws', 'gcp', 'azure', 'docker', 'kubernetes', 'terraform', 'pulumi', 'cloudflare',
    'vercel', 'netlify', 'heroku', 'digitalocean', 'lambda', 'ec2', 's3', 'ecs', 'eks',
    'fargate', 'cloudrun', 'appengine',
    // Databases
    'postgresql', 'postgres', 'mysql', 'sqlite', 'mongodb', 'redis', 'dynamodb',
    'cassandra', 'elasticsearch', 'opensearch', 'neo4j', 'supabase', 'planetscale',
    'cockroachdb', 'timescaledb', 'clickhouse', 'drizzle', 'prisma', 'typeorm', 'knex',
    // Tools
    'git', 'npm', 'yarn', 'pnpm', 'webpack', 'vite', 'esbuild', 'rollup', 'turbopack',
    'eslint', 'prettier', 'jest', 'vitest', 'playwright', 'cypress', 'storybook',
    'github-actions', 'gitlab-ci', 'jenkins', 'circleci',
    // Patterns
    'authentication', 'authorization', 'caching', 'rate-limiting', 'error-handling',
    'testing', 'logging', 'monitoring', 'ci-cd', 'deployment', 'migration',
    'api-design', 'graphql', 'rest', 'grpc', 'websocket', 'ssr', 'ssg', 'isr',
    'serverless', 'microservices', 'monorepo', 'orm', 'queue', 'pubsub',
]);
const PLATFORM_TAGS = new Set([
    'aws', 'gcp', 'azure', 'cloudflare', 'vercel', 'netlify', 'heroku',
    'digitalocean', 'docker', 'kubernetes', 'lambda', 'aws-lambda', 'nextjs',
    'postgresql', 'mongodb', 'redis', 'supabase', 'planetscale',
]);
function isTechnologyTag(tag) {
    return KNOWN_TECH_TAGS.has(tag.toLowerCase());
}
/**
 * Batch-filter knowledge entries into anonymous patterns.
 * Only returns patterns that pass all privacy checks.
 */
export function filterBatch(entries, config = {}) {
    const patterns = [];
    const seen = new Set();
    for (const entry of entries) {
        const pattern = toAnonymousPattern(entry, entries, config);
        if (pattern && !seen.has(pattern.id)) {
            seen.add(pattern.id);
            patterns.push(pattern);
        }
    }
    return patterns;
}
//# sourceMappingURL=privacy-filter.js.map