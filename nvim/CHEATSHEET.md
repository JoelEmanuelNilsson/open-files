# Neovim cheatsheet

Open this file any time with `F1`, or with `Space` then `?`, or by typing
`:Cheatsheet` and pressing Enter.

## Start here: the only six keys you need

Ignore the rest of this file until these six are automatic. They cover almost
everything you will ever do.

| Key | Does |
|---|---|
| `i` | **Start typing.** Nothing you type goes into the file until you press this. |
| `Esc` | **Stop typing.** Back to safety. When lost, press this. |
| `Ctrl-S` | Save |
| `Ctrl-Z` | Undo |
| `Space` `e` | Show or hide the sidebar. Then **click** the file you want. |
| `Space` | Opens a menu on the right listing every command. You never have to remember the rest. |

Everything below is reference. You are not expected to learn it.

## The one rule

Neovim has modes. This is the only idea you must hold.

| Mode | What it is | How to get there |
|---|---|---|
| **NORMAL** | Keys are commands. You cannot type text. | `Esc` |
| **INSERT** | Keys type text, like any editor. | `i` |
| **VISUAL** | You are selecting text. | `v`, or drag the mouse |

The bar at the bottom left always tells you which mode you are in.
If anything ever feels stuck: press `Esc`.

**Why does `s` delete a letter and start typing?** Because in NORMAL mode
every letter is a command, not a letter. `s` is the command "substitute": it
removes the character under the cursor and puts you in INSERT mode. `x`
deletes a character, `d` starts a delete, `o` opens a new line. This is why
NORMAL mode feels like the keyboard is possessed until you accept the rule:
**in NORMAL mode the keyboard is a control panel, in INSERT mode it is a
keyboard.**

## Saving and throwing work away

| Action | How |
|---|---|
| Save | `Ctrl-S` |
| Undo the last thing | `Ctrl-Z` |
| Undo everything back to the last save | `Space` `d`, then confirm |
| Quit without saving | `:q!` then Enter |

`Space` `d` reloads the file from the disk. It asks first, and it only touches
the file you are looking at.

## What the bottom bar means

`NORMAL` — the mode you are in.
` main` — the git branch.
` 2` — two lines changed since the last commit.
`README.md ● UNSAVED` — the file, and whether it has unsaved changes.
`󰈭 912 words` — word count, markdown files only.
`Ln 9, Col 12` — the cursor is on line 9, character 12.

## The shortcuts you already know

| Key | Does |
|---|---|
| `Ctrl-S` | Save |
| `Ctrl-Z` | Undo |
| `Ctrl-Y` | Redo |
| `Ctrl-A` | Select all |
| `Ctrl-C` | Copy the selection |
| `Ctrl-V` | Paste (while typing) |
| `Ctrl-F` | Find in this file. Type, press Enter, then `n` for the next hit |
| `Ctrl-P` | Find a file by name |
| `Esc` | Stop. Also clears the yellow search highlight |

## The sidebar

| Action | How |
|---|---|
| Show or hide it | `Space` `e` |
| Put the cursor in it | **Click** in it |
| Find the open file in the tree | `Space` `E` |
| Open a file / fold a folder | **Click it** |
| New file | `a`, then type a name |
| Rename | `r` |
| Delete | `d` |
| Show or hide dotfiles | `H` |
| Widen it to fit the longest name | `e`. Press `e` again to go back |
| Leave the sidebar | `q` |

### Moving the sidebar to a different folder

Two keys, and they are each other's undo. Nothing on screen tells you this.

| Key | Does |
|---|---|
| `Backspace` | Move **up** one folder, so you can see where your project sits |
| `.` | Move **down**: the folder under the cursor becomes the top of the tree |

If `Backspace` took you somewhere you did not want, put the cursor on your
project folder and press `.` to come back.

### The letters on the right of a filename

The sidebar marks every file with its git state, like VS Code does.

| Mark | Means |
|---|---|
| nothing | Committed. Saved and safe. |
| `M` gold | Changed since the last commit. |
| `U` blue | Brand new. Git has never seen this file. |
| `A` green | Added to the next commit. |
| `✓` green | This change is **staged**, that is, picked for the next commit. |
| `D` red | Deleted. |
| `!` red | Conflict. Two versions disagree. |

`M` on its own means changed but not staged yet. `M ✓` means changed and
staged. The filename itself takes the same colour, so you can see the state
without reading the letter.

## Moving between open files

| Action | How |
|---|---|
| Next / previous tab | `Shift-Right` / `Shift-Left` |
| Jump to tab 1..9 | `Space` `1` .. `Space` `9` |
| Back to the file you were just in | `Space` `Space` |
| List every open file | `Space` `b` |
| Recently opened files | `Space` `r` |
| Close this file | `Space` `w` |
| Click a tab | **Click it**. Click the `x` to close it |

A tab showing `●` instead of `x` has unsaved changes.

## Finding things

| Action | How |
|---|---|
| Find a file by name | `Ctrl-P` or `Space` `f` |
| Search text across all files | `Space` `s` |
| Search inside this file | `Ctrl-F` |

In any of these lists: type to filter, arrow keys to move, `Enter` to open,
`Esc` to cancel.

## Git

Press `Space` `g`. The git screen opens as its own full-screen tab and lists
three groups: **Untracked** (new files), **Unstaged changes** (edited, not
picked yet) and **Staged changes** (picked for the next commit).

### Seeing what actually changed

This is the part that is not obvious. The file list does not show the changed
lines until you ask for them.

| Want | Key |
|---|---|
| Show the changed lines under a file, in place | Put the cursor on the file, press `Tab` |
| Open a proper side-by-side diff, old left, new right | `d` on the file |
| Close the side-by-side diff | `q` |

### Making a commit

| Step | Key |
|---|---|
| 1. Pick a file for the commit | `s` on the file (it moves to Staged) |
| 2. Changed your mind | `u` to unstage, `x` to throw the change away |
| 3. Write the message | `c` `c`, type the message, then `Ctrl-S` and `:q` |
| 4. Send it to GitHub | `p` `p` |
| Close the git screen | `q` |
| Full list of keys | `?` |

### While you are editing a file

The left margin shows a bar next to every line you changed since the last
commit. The line the cursor is on shows, in grey at the end, who last changed
it and when.

## Markdown

| Action | How |
|---|---|
| Continue a bullet or numbered list | Press `Enter` at the end of the line |
| Tick a checkbox on or off | `Space` `x` |
| Indent a list item | `Tab` in insert mode |
| Switch the drawing off, back to raw `#` and `**` | `Space` `m` |
| Switch it on again | `Space` `m` |

Headings, bullets, tables and code blocks are drawn, not shown as raw `#` and
`**`. Put your cursor on a line and the raw text comes back so you can edit it.

`Space` `m` is the master switch for that drawing. Off gives you the plain
file exactly as it sits on disk, which is what you want when you are editing
the marks themselves or copying raw markdown out. The bottom of the screen
says which state you are in.

## Line numbers

They are on. `Space` `n` turns them off and on for the window you are in.
Turn them off before you select text with the mouse to copy it out of the
terminal, otherwise the numbers come along with the text.

## Editing without the mouse, the few keys worth learning

| Key | Does |
|---|---|
| `i` | Start typing where the cursor is |
| `o` | Open a new line below and start typing |
| `dd` | Delete the whole line |
| `yy` | Copy the whole line |
| `p` | Paste it below |
| `u` | Undo (same as `Ctrl-Z`) |
| `gg` / `G` | Top / bottom of the file |
| `/word` | Jump to the next `word` |

## When you are lost

- `Esc` returns to normal mode. Always.
- `Space` alone opens a menu of everything the next key can do.
- `Space` `?` opens this file.
- `:q` quits the current file. `:qa` quits Neovim. If something is unsaved it
  will ask you first, not refuse.
