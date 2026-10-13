# Fuzzy File Search

Raycast command that lets you fuzzy-find files by their full path, not only by filename. It is built for people who keep projects in deeply nested folder structures and want to jump straight to the right file.

![Screenshot of the command list](./metadata/fuzzy-file-search-1.png)

## Why Use It Instead of Raycast's Built-in Search Files?

- Matches folder names and file names together (e.g. `algo home pdf` → `~/algorithms/homework.pdf`).
- Keeps context when several files share the same name in different directories.
- Queries the [`fsearch`](https://github.com/noahdunnagan/fsearch) daemon, which keeps a whole-disk index live and answers in a few milliseconds.
- Offers quick actions (open, show in Finder, copy path, Quick Look) without leaving Raycast.

## How It Works

- The `fsearch` daemon (`~/.local/bin/fsearch`, installed by the dotfiles `install.sh`) indexes the whole disk once and keeps the index current from FSEvents. The extension opens its socket and sends one query per search root.
- Words are fuzzy and matched per path component: every word must match inside one folder or file name, so `raycast readme` finds `~/dotfiles/raycast/fuzzy-file-search/README.md`. Joined words such as `raycastreadme` match nothing.
- The extension merges the hits of all queries by fsearch score, takes the best 2000, then re-ranks them by match quality and recency and shows 200.
- If the daemon is not running the extension starts it. While it builds its first index (about 20 seconds) the command says so.

## Manual Step: Full Disk Access

Grant Full Disk Access to `~/.local/bin/fsearch` in System Settings → Privacy & Security → Full Disk Access, and again after each rebuild. Without it the daemon skips protected folders and the command shows a toast saying so.

## Configure the Search

Open the Raycast extension preferences to tailor the results:

- `Include Directories`: show both directories and files (enabled by default).
- `Custom Search Directories`: space-separated list of extra roots. Use the search bar dropdown inside the command to switch between `Home (~)`, `Everything (/)`, or your custom set.

## What Is Searched

The default roots are your home folder, `/tmp`, `/Applications` and `~/Library/CloudStorage`; `~/Library` is left out. `Everything (/)` searches the whole index.

Results are folders and the file types you open: images (png, jpg, webp, gif, avif, heic, svg, tiff, bmp), videos (mp4, mov, webm, mkv, m4v), Markdown, txt, HTML, PDF, CSV and Office/iWork documents. Code and other files are left out; add `-a` to a query to search every file type.

Hidden and gitignored files are included. Folders named `.git` or `node_modules`, and anything inside them, are excluded. Symlinks are not followed: fsearch indexes real paths.

## Tips

- Use `-d` to search directories only, `-f` to search files only (e.g. `sat -d`), and `-a` to search every file type, code included.
- Combine folder hints and filename fragments in the query to jump straight to the exact file you want.
