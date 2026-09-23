-- Finding and reopening files.
return {
  {
    'folke/snacks.nvim',
    priority = 1000,
    lazy = false,
    opts = {
      picker = {
        enabled = true,
        -- Show everything by default. `fd` and `ripgrep` normally hide two
        -- whole classes of file: names starting with a dot (.env, .claude/)
        -- and anything listed in .gitignore (scratch files, build output,
        -- node_modules). That is why a file you know exists could not be
        -- found unless you typed its exact path: it was never in the list.
        --   Alt-h   hide dotfiles again
        --   Alt-i   respect .gitignore again
        -- Both are toggles, press again to come back.
        sources = {
          -- `.git` stays out. It holds thousands of machine-written files
          -- that you will never open, and they would drown every search.
          files = { hidden = true, ignored = true, exclude = { '.git' } },
          grep  = { hidden = true, ignored = true, exclude = { '.git' } },
          smart = { hidden = true, ignored = true, exclude = { '.git' } },
        },
      },
      notifier = { enabled = true },
      input = { enabled = true },
      bigfile = { enabled = true },
      bufdelete = { enabled = true },
      -- The screen you get when you run `nvim` with no file. It lists the
      -- files you had open recently, so you can go straight back to one.
      dashboard = {
        enabled = true,
        preset = {
          header = table.concat({
            '                                       ',
            '  ██╗   ██╗ ██████╗ ████████╗███████╗  ',
            '  ██║   ██║██╔═══██╗╚══██╔══╝██╔════╝  ',
            '  ██║   ██║██║   ██║   ██║   █████╗    ',
            '  ╚██╗ ██╔╝██║   ██║   ██║   ██╔══╝    ',
            '   ╚████╔╝ ╚██████╔╝   ██║   ███████╗  ',
            '    ╚═══╝   ╚═════╝    ╚═╝   ╚══════╝  ',
          }, '\n'),
          keys = {
            { icon = ' ', key = 'f', desc = 'Find a file', action = ':lua Snacks.dashboard.pick("files")' },
            { icon = ' ', key = 'r', desc = 'Recent files', action = ':lua Snacks.dashboard.pick("oldfiles")' },
            { icon = ' ', key = 'e', desc = 'File sidebar', action = ':Neotree focus' },
            { icon = ' ', key = 's', desc = 'Search inside files', action = ':lua Snacks.dashboard.pick("live_grep")' },
            { icon = ' ', key = 'g', desc = 'Git', action = ':Neogit' },
            { icon = ' ', key = '?', desc = 'Cheatsheet', action = ':lua vim.cmd("edit " .. vim.fn.stdpath("config") .. "/CHEATSHEET.md")' },
            { icon = ' ', key = 'q', desc = 'Quit', action = ':qa' },
          },
        },
        sections = {
          { section = 'header' },
          { section = 'keys', gap = 0, padding = 1 },
          { section = 'recent_files', title = 'Recent', icon = ' ', indent = 2, padding = 1, limit = 8 },
          { section = 'startup' },
        },
      },
    },
    keys = {
      { '<C-p>', function() Snacks.picker.files() end, desc = 'Find a file by name' },
      { '<leader>f', function() Snacks.picker.files() end, desc = 'Find a file by name' },
      { '<leader>s', function() Snacks.picker.grep() end, desc = 'Search text inside files' },
      { '<C-S-f>', function() Snacks.picker.grep() end, desc = 'Search text inside files' },
      { '<leader>b', function() Snacks.picker.buffers() end, desc = 'Open files' },
      { '<leader>r', function() Snacks.picker.recent() end, desc = 'Recent files' },
      { '<leader>h', function() Snacks.picker.help() end, desc = 'Help topics' },
    },
  },
}
