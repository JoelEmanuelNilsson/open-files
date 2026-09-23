-- Keys. The goal is that the shortcuts you already know from other editors
-- do what you expect. Escape is left alone on purpose: it always means
-- "stop what you are doing and go back to normal mode".

local map = vim.keymap.set

-- ── Save, undo, redo ───────────────────────────────────────────────────────
-- Ctrl-S saves from any mode and leaves you in normal mode.
map({ 'n', 'i', 'v' }, '<C-s>', '<Esc><cmd>write<cr>', { desc = 'Save' })

-- Ctrl-Z undo, Ctrl-Y redo. Both work while typing.
map('n', '<C-z>', 'u', { desc = 'Undo' })
map('i', '<C-z>', '<C-o>u', { desc = 'Undo' })
map('n', '<C-y>', '<C-r>', { desc = 'Redo' })
map('i', '<C-y>', '<C-o><C-r>', { desc = 'Redo' })

-- ── Select, copy, paste ────────────────────────────────────────────────────
map('n', '<C-a>', 'ggVG', { desc = 'Select all' })
map('v', '<C-c>', '"+y', { desc = 'Copy' })
map('i', '<C-v>', '<C-r>+', { desc = 'Paste' })
-- Pasting over selected text no longer overwrites your clipboard.
vim.cmd([[ xnoremap <expr> p 'pgv"'.v:register.'y' ]])

-- ── Find ───────────────────────────────────────────────────────────────────
map('n', '<C-f>', '/', { desc = 'Find in this file' })
map('i', '<C-f>', '<Esc>/', { desc = 'Find in this file' })
-- Escape clears the yellow search highlight.
map('n', '<Esc>', '<cmd>nohlsearch<cr>', { desc = 'Clear search highlight' })

-- ── Moving through wrapped lines ───────────────────────────────────────────
-- Down and up move by what you see on screen, not by the line in the file.
-- Without this, one long paragraph is a single jump.
map({ 'n', 'v' }, '<Down>', "v:count == 0 ? 'gj' : 'j'", { expr = true })
map({ 'n', 'v' }, '<Up>', "v:count == 0 ? 'gk' : 'k'", { expr = true })
map({ 'n', 'v' }, 'j', "v:count == 0 ? 'gj' : 'j'", { expr = true })
map({ 'n', 'v' }, 'k', "v:count == 0 ? 'gk' : 'k'", { expr = true })

-- ── Switching between open files ───────────────────────────────────────────
map('n', '<S-Right>', '<cmd>BufferLineCycleNext<cr>', { desc = 'Next file' })
map('n', '<S-Left>', '<cmd>BufferLineCyclePrev<cr>', { desc = 'Previous file' })
map('n', '<leader><leader>', '<cmd>e #<cr>', { desc = 'Back to the last file' })
for i = 1, 9 do
  map('n', '<leader>' .. i, function()
    require('bufferline').go_to(i, true)
  end, { desc = 'Go to file ' .. i })
end

-- ── Back and forward ───────────────────────────────────────────────────────
-- Neovim remembers every place you jumped from, and Ctrl-O and Ctrl-I walk
-- that list. º and ç used to be bound here as easier keys for them. They are
-- gone because AeroSpace now grabs those two at the OS level to open its
-- keyboard layer, and a key the window manager takes never reaches Neovim at
-- all — a binding here would look correct and do nothing.

-- ── Closing ────────────────────────────────────────────────────────────────
map('n', '<leader>w', function() Snacks.bufdelete() end, { desc = 'Close this file' })
map('n', '<leader>Q', '<cmd>qa<cr>', { desc = 'Quit Neovim' })

-- ── Throwing away changes ──────────────────────────────────────────────────
-- Reload the file from disk and lose everything you typed since the last save.
map('n', '<leader>d', function()
  if not vim.bo.modified then
    vim.notify('Nothing to discard, this file is saved.')
    return
  end
  local answer = vim.fn.confirm('Throw away all unsaved changes to this file?', '&Yes\n&No', 2)
  if answer == 1 then
    vim.cmd('edit!')
    vim.notify('Changes discarded.')
  end
end, { desc = 'Discard unsaved changes' })

-- ── Line numbers ───────────────────────────────────────────────────────────
-- They are on by default. This turns them off and on for the window you are
-- in, which is what you want before copying a block of text out of the
-- terminal, or when you just want the page clean.
map('n', '<leader>n', function()
  local on = not vim.wo.number
  vim.wo.number = on
  vim.notify(on and 'Line numbers: on' or 'Line numbers: off')
end, { desc = 'Line numbers on or off' })

-- ── Help ───────────────────────────────────────────────────────────────────
local function cheatsheet()
  vim.cmd('edit ' .. vim.fn.stdpath('config') .. '/CHEATSHEET.md')
end
vim.api.nvim_create_user_command('Cheatsheet', cheatsheet, { desc = 'Open the cheatsheet' })
map('n', '<leader>?', cheatsheet, { desc = 'Cheatsheet' })
map('n', '<F1>', cheatsheet, { desc = 'Cheatsheet' })
