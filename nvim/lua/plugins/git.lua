return {
  {
    'NeogitOrg/neogit',
    dependencies = { 'nvim-lua/plenary.nvim', 'sindrets/diffview.nvim' },
    -- `cmd` makes lazy.nvim reserve the :Neogit command up front, so anything
    -- that calls it by name (the start screen) works before the plugin loads.
    cmd = { 'Neogit' },
    -- Space g is the one git key. Everything else happens inside the git
    -- screen, so there is nothing extra to remember.
    keys = { { '<leader>g', function() require('neogit').open() end, desc = 'Git' } },
    opts = {
      -- The one setting that changes behaviour: pressing d on a file now opens
      -- a real side-by-side diff instead of Neogit's own inline one.
      integrations = { diffview = true },

      -- Cosmetic only. Neogit ships ASCII > and v arrows; these are the same
      -- arrows the sidebar uses, so folding looks the same in both places.
      signs = {
        section = { '', '' },
        item = { '', '' },
        hunk = { '', '' },
      },
      graph_style = 'unicode',   -- cosmetic: draws the commit graph with lines, not | and *
    },
    config = function(_, opts)
      require('neogit').setup(opts)

      -- Keep the git screen out of the row of file tabs at the top, and stop
      -- it wrapping long diff lines into an unreadable block.
      vim.api.nvim_create_autocmd('FileType', {
        pattern = 'NeogitStatus',
        callback = function(ev)
          vim.wo.wrap = false
          vim.bo[ev.buf].buflisted = false
        end,
      })
    end,
  },

  {
    'sindrets/diffview.nvim',
    cmd = { 'DiffviewOpen', 'DiffviewFileHistory' },
    opts = {
      -- Off by default. On, changed words inside a line are highlighted, not
      -- just the whole line.
      enhanced_diff_hl = true,
      -- q closes the diff, the same key that closes everything else here.
      keymaps = {
        view = { { 'n', 'q', '<cmd>DiffviewClose<cr>', { desc = 'Close the diff' } } },
        file_panel = { { 'n', 'q', '<cmd>DiffviewClose<cr>', { desc = 'Close the diff' } } },
        file_history_panel = { { 'n', 'q', '<cmd>DiffviewClose<cr>', { desc = 'Close the diff' } } },
      },
    },
  },

  {
    'lewis6991/gitsigns.nvim',
    event = 'BufWinEnter',
    opts = {
      current_line_blame = true,   -- who last changed this line
      -- Cosmetic: a solid bar in the left margin reads better than the
      -- default + and _ characters.
      signs = {
        add          = { text = '┃' },
        change       = { text = '┃' },
        delete       = { text = '' },
        topdelete    = { text = '' },
        changedelete = { text = '~' },
        untracked    = { text = '┆' },
      },
      preview_config = { border = 'rounded' },
    },
  },
}
