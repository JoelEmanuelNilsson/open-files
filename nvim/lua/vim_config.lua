-- Editor options. Plain Neovim settings, no plugins involved.
local o = vim.opt

vim.g.mapleader = ' '          -- Space is the leader key

-- ── Text and prose ─────────────────────────────────────────────────────────
-- Markdown is prose, so lines must wrap at word boundaries, not mid-word.
o.wrap = true                  -- long lines continue on the next screen line
o.linebreak = true             -- break between words, never inside a word
o.breakindent = true           -- a wrapped line keeps the indent of its bullet
o.showbreak = '↪ '             -- marks a line that is a continuation
o.conceallevel = 0             -- never hide characters; show the file as it is
o.expandtab = true             -- spaces, not tabs
o.shiftwidth = 2               -- 2 spaces per indent level
o.textwidth = 0                -- never hard-wrap the actual file contents

-- ── Seeing where you are ───────────────────────────────────────────────────
o.number = true                -- line numbers
o.relativenumber = false       -- plain numbers that do not move around
o.cursorline = true            -- highlight the line the cursor is on
o.signcolumn = 'yes'           -- always reserve the git +/- column, no jitter
o.scrolloff = 8                -- keep 8 lines visible above and below the cursor
o.showmode = false             -- the status bar shows the mode instead
o.laststatus = 3               -- one status bar for the whole window
o.winborder = 'rounded'        -- rounded edges on popup windows

-- ── Searching ──────────────────────────────────────────────────────────────
o.ignorecase = true            -- search ignores case
o.smartcase = true             -- unless you type a capital letter
o.hlsearch = true              -- highlight every match (Esc clears it)
o.incsearch = true             -- jump to matches as you type

-- ── Safety ─────────────────────────────────────────────────────────────────
o.undofile = true              -- undo history survives closing the file
o.confirm = true               -- closing with unsaved changes asks, never fails
o.updatetime = 200             -- how fast git signs and hovers refresh
o.timeoutlen = 400             -- how long the Space menu waits for the next key

-- ── Mouse and clipboard ────────────────────────────────────────────────────
o.mouse = 'a'                  -- mouse works everywhere
o.mousemoveevent = true        -- hover effects, e.g. the x on a tab
o.mousescroll = 'ver:3,hor:0'  -- three lines per wheel notch
o.clipboard = 'unnamedplus'    -- share the macOS clipboard

-- ── Colour ─────────────────────────────────────────────────────────────────
-- Off, so nvim uses the terminal's 16 ANSI colours instead of its own hex
-- defaults, which from 0.10 on ignore the terminal palette. See theme/README.md.
vim.o.termguicolors = false

-- ── Windows ────────────────────────────────────────────────────────────────
o.splitright = true
o.splitbelow = true

-- Turn on treesitter for markdown. Neovim ships the markdown parser, so this
-- needs no plugin. It is what gives headings, links and code blocks real
-- colours. It only colours; with conceallevel = 0 it hides nothing.
vim.api.nvim_create_autocmd('FileType', {
  pattern = { 'markdown', 'lua', 'query', 'vim' },
  callback = function() pcall(vim.treesitter.start) end,
})

-- Briefly highlight text you copy, so you can see what was taken.
vim.api.nvim_create_autocmd('TextYankPost', {
  callback = function() vim.hl.on_yank({ timeout = 150 }) end,
})
