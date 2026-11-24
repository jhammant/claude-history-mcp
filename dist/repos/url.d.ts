/**
 * Remove userinfo (everything up to the last `@`), query and fragment from a remote URL.
 * Applies to URL forms (`scheme://...`) and scp-like forms (`user@host:path`); a local path
 * is returned unchanged.
 */
export declare function stripRemoteCredentials(url: string): string;
/** Parse `a=b,c=d` into lower-case host pairs; malformed entries are ignored. */
export declare function parseHostAliases(spec: string | undefined): Map<string, string>;
/** The aliases configured in CLAUDE_HISTORY_REPO_HOST_ALIASES. */
export declare function hostAliasesFromEnv(): Map<string, string>;
/** host/owner/name, lower-case host, no scheme, user, port or .git; null if not a URL. */
export declare function normaliseRemote(url: string, aliases?: Map<string, string>): string | null;
//# sourceMappingURL=url.d.ts.map