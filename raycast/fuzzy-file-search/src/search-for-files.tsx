import { ActionPanel, List, Action, getPreferenceValues, showToast, Toast, Icon } from "@raycast/api";
import { useCachedState, usePromise } from "@raycast/utils";
import path, { basename } from "path";
import { useEffect, useMemo, useState } from "react";
import { parseSearchQuery } from "./lib/parse-search-query";
import { lookupPastedPath, normalizePastedPath, PastedPathEntry } from "./lib/pasted-path";
import { buildFsearchQueries, parseRoots } from "./lib/fsearch-queries";
import { FSEARCH_BINARY, hasFullDiskAccess, searchFsearch } from "./lib/fsearch";
import { rankFuzzyMatchesByRecency } from "./lib/rank-fuzzy-matches";
import os from "os";

type Prefs = {
  includeDirectories: boolean;
  customSearchDirs: string;
};

const MAX_FSEARCH_CANDIDATES = 2000;
const MAX_DISPLAYED_RESULTS = 200;
const SEARCH_DEBOUNCE_MS = 200;
const DEFAULT_SEARCH_ROOTS = `${os.homedir()} /tmp /Applications ${path.join(os.homedir(), "Library", "CloudStorage")}`;
const EVERYTHING_SEARCH_ROOTS = "/";

const INSTALL_COMMAND = `cargo install --git https://github.com/noahdunnagan/fsearch --rev 76d612f5b23802eb24926b47e9c4f4ef26884014 --root ~/.local --locked`;

function displayFilePath(filepath: string): string {
  return filepath.startsWith(os.homedir()) ? filepath.replace(os.homedir(), "~") : filepath;
}

function FileListItem(props: { filepath: string; mtimeMs: number; isDirectory?: boolean; onDrillIn?: () => void }) {
  const { filepath, mtimeMs, isDirectory, onDrillIn } = props;
  const filename = basename(filepath);
  const modified = new Date(mtimeMs);
  return (
    <List.Item
      title={isDirectory ? `${displayFilePath(filepath)}/` : displayFilePath(filepath)}
      subtitle={filename}
      icon={isDirectory === undefined ? undefined : { fileIcon: filepath }}
      accessories={[{ date: modified, tooltip: `Modified ${modified.toLocaleString()}` }]}
      quickLook={{ path: filepath, name: filename }}
      actions={
        <ActionPanel>
          <Action.Open title="Open" target={filepath} />
          <Action.ShowInFinder title="Show in Finder" path={filepath} />
          {onDrillIn && (
            <Action
              title="Search Inside Directory"
              icon={Icon.ArrowRight}
              shortcut={{ modifiers: ["cmd"], key: "arrowRight" }}
              onAction={onDrillIn}
            />
          )}
          <Action.OpenWith path={filepath} shortcut={{ modifiers: ["cmd"], key: "o" }} />
          <Action.CopyToClipboard
            title="Copy Path to Clipboard"
            content={filepath}
            shortcut={{ modifiers: ["cmd"], key: "c" }}
          />
          <Action.ToggleQuickLook shortcut={{ modifiers: ["cmd"], key: "y" }} />
        </ActionPanel>
      }
    />
  );
}

export default function Command() {
  const prefs = getPreferenceValues<Prefs>();

  const [searchText, setSearchText] = useState("");
  const [searchRoot, setSearchRoot] = useCachedState<string>("searchRootsKey", DEFAULT_SEARCH_ROOTS);
  const parsedSearch = useMemo(() => parseSearchQuery(searchText, os.homedir()), [searchText]);
  const pastedPath = useMemo(() => normalizePastedPath(searchText, os.homedir()), [searchText]);
  const fuzzyQuery = pastedPath === null ? parsedSearch.query : pastedPath;
  const [debouncedQuery, setDebouncedQuery] = useState(fuzzyQuery);
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQuery(fuzzyQuery), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [fuzzyQuery]);

  useEffect(() => {
    hasFullDiskAccess().then((granted) => {
      if (granted === false) {
        showToast({
          style: Toast.Style.Failure,
          title: "Protected folders are skipped",
          message: `Grant Full Disk Access to ${FSEARCH_BINARY} in System Settings`,
        });
      }
    });
  }, []);

  const { data: outcome, isLoading: isSearchLoading } = usePromise(
    async (query: string, searchType: typeof parsedSearch.searchType, roots: string, includeDirectories: boolean) => {
      const rootList = parseRoots(roots);
      if (rootList.length === 0) return { kind: "no-roots" as const };
      const queries = buildFsearchQueries({ query, searchType }, rootList, os.homedir(), includeDirectories);
      const result = await searchFsearch(queries, MAX_FSEARCH_CANDIDATES);
      if (result.kind !== "hits") return result;
      const candidates = result.hits.map((hit, fsearchRank) => ({
        path: hit.path,
        fsearchRank,
        mtimeMs: hit.mtime * 1000,
      }));
      const { terms } = parseSearchQuery(query, os.homedir());
      return {
        kind: "matches" as const,
        matches: rankFuzzyMatchesByRecency(candidates, terms, Date.now()).slice(0, MAX_DISPLAYED_RESULTS),
      };
    },
    [debouncedQuery, parsedSearch.searchType, searchRoot, prefs.includeDirectories],
    { execute: debouncedQuery.length > 0 },
  );

  const { data: pastedPathLookup, isLoading: isPastedPathLoading } = usePromise(
    (text: string) => lookupPastedPath(text, os.homedir()),
    [searchText],
    { execute: pastedPath !== null },
  );
  const directEntries: PastedPathEntry[] =
    pastedPath !== null && pastedPathLookup?.normalizedPath === pastedPath
      ? [...(pastedPathLookup.exact ? [pastedPathLookup.exact] : []), ...pastedPathLookup.completions]
      : [];
  const directPaths = new Set(directEntries.map((entry) => entry.path));

  const shownOutcome = debouncedQuery ? outcome : undefined;
  const fuzzyMatches =
    shownOutcome?.kind === "matches" ? shownOutcome.matches.filter((match) => !directPaths.has(match.path)) : undefined;

  return (
    <List
      navigationTitle="Search Files"
      searchText={searchText}
      isLoading={(pastedPath !== null && isPastedPathLoading) || isSearchLoading || debouncedQuery !== fuzzyQuery}
      searchBarPlaceholder={"Search files — -d folders, -f files, -a every file type"}
      onSearchTextChange={setSearchText}
      filtering={false} // disable builtin filtering as we use a custom one
      searchBarAccessory={
        <List.Dropdown tooltip="Search" value={searchRoot} onChange={setSearchRoot}>
          <List.Dropdown.Item title="Home, /tmp, Applications" value={DEFAULT_SEARCH_ROOTS} />
          <List.Dropdown.Item title="Everything (/)" value={EVERYTHING_SEARCH_ROOTS} />
          <List.Dropdown.Item title="Custom Directories" value={prefs.customSearchDirs} />
        </List.Dropdown>
      }
    >
      <List.Section title="Path">
        {directEntries.map((entry) => (
          <FileListItem
            key={entry.path}
            filepath={entry.path}
            mtimeMs={entry.mtimeMs}
            isDirectory={entry.isDirectory}
            onDrillIn={entry.isDirectory ? () => setSearchText(path.join(entry.path, "/")) : undefined}
          />
        ))}
      </List.Section>
      {shownOutcome?.kind === "indexing" && (
        <List.EmptyView
          icon={Icon.Clock}
          title="fsearch is indexing the disk"
          description="The first scan takes about 20 seconds. Search again once it finishes."
        />
      )}
      {shownOutcome?.kind === "no-roots" && (
        <List.EmptyView
          icon={Icon.Folder}
          title="No custom directories are set"
          description="Add directories to the Custom Search Directories preference, or pick another search scope."
        />
      )}
      {shownOutcome?.kind === "binary-missing" && (
        <List.EmptyView
          icon={Icon.Download}
          title="fsearch is not installed"
          description={`Run ./install.sh in the dotfiles repo, or: ${INSTALL_COMMAND} && ${FSEARCH_BINARY} install --login`}
        />
      )}
      {shownOutcome?.kind === "error" && (
        <List.EmptyView icon={Icon.ExclamationMark} title="fsearch failed" description={shownOutcome.message} />
      )}
      <List.Section title="Fuzzy Matches">
        {fuzzyMatches?.map((match) => (
          <FileListItem key={match.path} filepath={match.path} mtimeMs={match.mtimeMs} />
        ))}
      </List.Section>
    </List>
  );
}
