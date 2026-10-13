import type { ParsedSearch } from "./parse-search-query.ts";

const BULK_EXCLUSIONS = ["!.git$", "!node_modules$"];
const LIBRARY_EXCLUSION = "!library$";

const VIEWABLE_EXTENSIONS = [
  // images
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "avif",
  "heic",
  "heif",
  "svg",
  "tif",
  "tiff",
  "bmp",
  // videos
  "mp4",
  "mov",
  "webm",
  "mkv",
  "m4v",
  // text
  "md",
  "mdx",
  "markdown",
  "txt",
  "html",
  "htm",
  // documents
  "pdf",
  "csv",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "key",
  "pages",
  "numbers",
];

const VIEWABLE_FILTER = `ext:${VIEWABLE_EXTENSIONS.join(",")}`;

function kindFilters({ searchType }: Pick<ParsedSearch, "searchType">, includeDirectories: boolean): string[] {
  switch (searchType) {
    case "directory":
      return ["kind:dir"];
    case "file":
      return [VIEWABLE_FILTER];
    case "viewable":
      return includeDirectories ? ["kind:dir", VIEWABLE_FILTER] : [VIEWABLE_FILTER];
    case "everything":
      return [includeDirectories ? "" : "kind:file"];
  }
}

/** Splits a roots string on whitespace into root paths with trailing slashes removed (`//` is `/`, `/a//` is `/a`). */
export function parseRoots(text: string): string[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((root) => root.replace(/\/+$/, "") || "/");
}

/** One fsearch query per root and result kind; the home root leaves ~/Library out and `/` has no scope. */
export function buildFsearchQueries(
  search: ParsedSearch,
  roots: ReadonlyArray<string>,
  home: string,
  includeDirectories: boolean,
): string[] {
  return roots.flatMap((root) => {
    const scope = root === "/" ? "" : `in:${root}`;
    const library = root === home ? LIBRARY_EXCLUSION : "";
    return kindFilters(search, includeDirectories).map((kind) =>
      [scope, kind, ...BULK_EXCLUSIONS, library, search.query].filter(Boolean).join(" "),
    );
  });
}
