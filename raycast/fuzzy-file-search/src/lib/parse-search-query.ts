/** Which entries a search returns: `viewable` is directories plus viewable files, `file` is viewable files only, `everything` is every file type. */
export type SearchType = "viewable" | "directory" | "file" | "everything";

export type ParsedSearch = {
  query: string;
  searchType: SearchType;
  hasDirectives: boolean;
  /** Literal match terms: no `!x` negations, `key:value` filters or `'`/`^`/`$` anchors. */
  terms: string[];
};

const DIRECTORY_DIRECTIVE = /^(?:\^|-)(?:d|dir|directory)$/i;
const FILE_DIRECTIVE = /^(?:\^|-)(?:f|file)$/i;
const EVERYTHING_DIRECTIVE = /^(?:\^|-)(?:a|all)$/i;

/** Expands a leading `~` or `~/` to the home directory; any other token is returned unchanged. */
export function expandHome(token: string, homeDir: string): string {
  return token === "~" || token.startsWith("~/") ? homeDir + token.slice(1) : token;
}

const FILTER_TOKEN = /^[A-Za-z_]+:/;

function literalTerm(token: string): string | undefined {
  if (token.startsWith("!") || FILTER_TOKEN.test(token)) return undefined;
  return token.replace(/^['^]+/, "").replace(/\$+$/, "") || undefined;
}

export function parseSearchQuery(searchText: string, homeDir: string): ParsedSearch {
  const keys = searchText.trim().split(/\s+/).filter(Boolean);
  let searchType: SearchType = "viewable";
  let hasDirectives = false;
  const queryParts: string[] = [];
  const terms: string[] = [];

  for (const rawKey of keys) {
    const key = expandHome(rawKey, homeDir);
    if (DIRECTORY_DIRECTIVE.test(key)) {
      searchType = "directory";
      hasDirectives = true;
    } else if (FILE_DIRECTIVE.test(key)) {
      searchType = "file";
      hasDirectives = true;
    } else if (EVERYTHING_DIRECTIVE.test(key)) {
      searchType = "everything";
      hasDirectives = true;
    } else {
      queryParts.push(key);
      const term = literalTerm(key);
      if (term) terms.push(term);
    }
  }

  return { query: queryParts.join(" "), searchType, hasDirectives, terms };
}
