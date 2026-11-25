/**
 * Git remote URLs: credential stripping and a canonical `host/owner/name` form, so the
 * same repository reached over https, ssh or scp syntax, or through an internal host
 * alias, gets one key. Pure functions; no I/O except reading the alias environment variable.
 */
import { CONFIG } from "../config.js";

/**
 * Remove userinfo (everything up to the last `@`), query and fragment from a remote URL.
 * Applies to URL forms (`scheme://...`) and scp-like forms (`user@host:path`); a local path
 * is returned unchanged.
 */
export function stripRemoteCredentials(url: string): string {
  let s = url.trim();
  const scheme = /^([a-z][a-z0-9+.-]*:\/\/)(.*)$/i.exec(s);
  if (scheme) {
    const at = scheme[2].lastIndexOf("@");
    s = scheme[1] + (at >= 0 ? scheme[2].slice(at + 1) : scheme[2]);
  } else if (!/^(?:\/|\.\/|\.\.\/)/.test(s)) {
    const at = s.lastIndexOf("@");
    if (at >= 0) s = s.slice(at + 1);
  } else {
    return s;
  }
  const cut = s.search(/[?#]/);
  return cut >= 0 ? s.slice(0, cut) : s;
}

/** Parse `a=b,c=d` into lower-case host pairs; malformed entries are ignored. */
export function parseHostAliases(spec: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of (spec ?? "").split(",")) {
    const eq = entry.indexOf("=");
    if (eq < 0) continue;
    const from = entry.slice(0, eq).trim().toLowerCase();
    const to = entry.slice(eq + 1).trim().toLowerCase();
    if (from && to) out.set(from, to);
  }
  return out;
}

/** The aliases configured in CLAUDE_HISTORY_REPO_HOST_ALIASES. */
export function hostAliasesFromEnv(): Map<string, string> {
  return parseHostAliases(CONFIG.repoHostAliases);
}

/** host/owner/name, lower-case host, no scheme, user, port or .git; null if not a URL. */
export function normaliseRemote(url: string, aliases: Map<string, string> = hostAliasesFromEnv()): string | null {
  // An `@` in the path (not the authority) would make last-`@` stripping turn path text into
  // the host and merge unrelated repositories: no key is better than a wrong one.
  const raw = url.trim();
  const schemeRaw = /^[a-z][a-z0-9+.-]*:\/\/(.*)$/i.exec(raw);
  if (schemeRaw) {
    const slash = schemeRaw[1].indexOf("/");
    if (slash >= 0 && schemeRaw[1].indexOf("@", slash) >= 0) return null;
  } else {
    const colon = raw.indexOf(":");
    if (colon >= 0 && raw.indexOf("@", colon) >= 0) return null;
  }
  const s = stripRemoteCredentials(url);
  if (!s || /[\s\\\0]/.test(s)) return null;
  let host: string;
  let path: string;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i.exec(s);
  if (scheme) {
    if (scheme[1].toLowerCase() === "file") return null;
    host = scheme[2].replace(/:\d*$/, "");
    path = scheme[3] ?? "";
  } else {
    if (/^(?:\/|\.\/|\.\.\/|~)/.test(s)) return null;
    const scp = /^([^/:]+):(.*)$/.exec(s);
    if (!scp) return null;
    host = scp[1];
    path = scp[2];
  }
  host = host.toLowerCase();
  if (host.length < 2) return null; // a Windows drive letter, not a host
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host)) return null;
  const segments = path.toLowerCase().split("/").filter(Boolean);
  if (segments.length < 2) return null;
  segments[segments.length - 1] = segments[segments.length - 1].replace(/\.git$/, "");
  if (segments.some((seg) => !seg || seg === "." || seg === "..")) return null;
  return `${aliases.get(host) ?? host}/${segments.join("/")}`;
}
