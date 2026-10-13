import afs from "fs/promises";
import path from "path";
import { expandHome } from "./parse-search-query.ts";
import { fileURLToPath } from "url";

/** A file or directory found on disk for a pasted path; `path` keeps the form the user typed (e.g. /tmp, not /private/tmp). */
export type PastedPathEntry = {
  readonly path: string;
  readonly isDirectory: boolean;
  readonly mtimeMs: number;
};

/** Direct lookup result for a pasted path: the exact file if it exists, plus completions of the typed basename, newest first. */
export type PastedPathLookup = {
  readonly normalizedPath: string;
  readonly exact: PastedPathEntry | null;
  readonly completions: ReadonlyArray<PastedPathEntry>;
};

const MAX_PATH_COMPLETIONS = 50;

function stripMatchingQuotes(text: string): { readonly inner: string; readonly quote: "'" | '"' | null } {
  for (const quote of ["'", '"'] as const) {
    if (text.length >= 2 && text.startsWith(quote) && text.endsWith(quote)) {
      return { inner: text.slice(1, -1), quote };
    }
  }
  return { inner: text, quote: null };
}

/**
 * Normalises pasted search text into an absolute path, or null when it does not look like a path.
 * Handles quotes, file:// URLs, a leading ~ and shell backslash escapes; does not touch the filesystem.
 */
export function normalizePastedPath(searchText: string, homeDir: string): string | null {
  const { inner, quote } = stripMatchingQuotes(searchText.trim());
  let text = inner;

  if (text.startsWith("file://")) {
    try {
      return fileURLToPath(text);
    } catch {
      return null;
    }
  }
  if (quote === null) {
    text = text.replace(/\\(.)/g, "$1");
  } else if (quote === '"') {
    text = text.replace(/\\(["\\$`])/g, "$1");
  }
  text = expandHome(text, homeDir);
  return text.startsWith("/") ? text : null;
}

async function statPathEntry(entryPath: string): Promise<PastedPathEntry | null> {
  try {
    const stat = await afs.stat(entryPath);
    return { path: entryPath, isDirectory: stat.isDirectory(), mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

async function listPathCompletions(dir: string, prefix: string, exclude: string): Promise<PastedPathEntry[]> {
  let names: string[];
  try {
    names = await afs.readdir(dir);
  } catch {
    return [];
  }
  const lowerPrefix = prefix.toLowerCase();
  const showHidden = prefix.startsWith(".");
  const matchingPaths = names
    .filter((name) => name.toLowerCase().startsWith(lowerPrefix) && (showHidden || !name.startsWith(".")))
    .map((name) => path.join(dir, name))
    .filter((entryPath) => entryPath !== exclude);
  const entries = await Promise.all(matchingPaths.map(statPathEntry));
  return entries
    .filter((entry) => entry !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_PATH_COMPLETIONS);
}

/**
 * Looks up a pasted path on disk: the exact entry (stat follows symlinks)
 * plus entries whose names start with the typed basename, or everything inside when the path ends in "/".
 * Unreadable entries and broken symlinks are left out.
 */
export async function lookupPastedPath(searchText: string, homeDir: string): Promise<PastedPathLookup | null> {
  const normalizedPath = normalizePastedPath(searchText, homeDir);
  if (normalizedPath === null) {
    return null;
  }
  const exactPath = normalizedPath.length > 1 ? normalizedPath.replace(/\/+$/, "") : normalizedPath;
  const exact = await statPathEntry(exactPath);
  const endsWithSlash = normalizedPath.endsWith("/");
  const completions = await listPathCompletions(
    endsWithSlash ? normalizedPath : path.dirname(normalizedPath),
    endsWithSlash ? "" : path.basename(normalizedPath),
    exactPath,
  );
  return { normalizedPath, exact, completions };
}
