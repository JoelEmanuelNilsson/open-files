# Fuzzy File Search Changelog

## [Search .scratch Folders] - 2026-10-13

- Stop skipping `.scratch` folders, so working documents inside them can be found by name

## [fsearch Backend] - 2026-09-26

- Query the fsearch daemon, which keeps a whole-disk index live from FSEvents, instead of re-crawling with `fd` and filtering with `fzf` on every open
- Remove the `fd` and `fzf` downloads, the indexing toast, and the `Follow Symbolic Links` and `Ignore Spaces in Search` preferences
- Show an empty view while the daemon is indexing or missing, and a toast when it lacks Full Disk Access

## [Index Hidden and Gitignored Files] - 2026-09-25

- Index hidden and gitignored files so they can be found by name; skip `.git`, `node_modules` and `.scratch`
- Remove the `Include Hidden` preference
- Index only folders, images, videos, Markdown, text, HTML, PDF and office documents; add `-a` to search every file type

## [Show in Finder Shortcut] - 2026-07-06

- Add Cmd+Enter shortcut to reveal the selected file in Finder by placing Show in Finder as the secondary action

## [Directory and File Search Directives] - 2026-06-17

- Add `-d` / `-f` query directives to search directories or files only
- Parse directives before filtering so they are not passed to `fzf` as search terms
- Debounce fzf filtering and cap results to avoid exceeding Raycast's extension memory limit

## [Open With Action] - 2026-03-12

- Add "Open With" action to open files with a specific application (Cmd+O).

## [Rework] - 2025-10-05

- Use fzf CLI tool for fuzzy finding.
- Add automatic installation of the fzf CLI tool.
- Improve search performance.
- Add caching of indexed files
- Improve UI/UX with toast notifications.
- Fix issue where the heap memory limit is reached.

## [Initial version] - 2025-09-15
