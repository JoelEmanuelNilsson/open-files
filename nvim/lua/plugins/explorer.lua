-- The sidebar on the left. This replaces oil.nvim, which showed a folder as a
-- block of editable text. neo-tree is the panel-and-tree kind, the same shape
-- as the VS Code explorer: click a file to open it, click a folder to fold it.
return {
  {
    'nvim-neo-tree/neo-tree.nvim',
    dependencies = {
      'nvim-lua/plenary.nvim',
      'nvim-tree/nvim-web-devicons',
      'MunifTanjim/nui.nvim',
    },
    lazy = false,
    -- One key for the sidebar: Space e. Ctrl-B belongs to another app on this
    -- machine, and the F-key row on a Mac needs Fn held down.
    keys = {
      { '<leader>e', '<cmd>Neotree toggle<cr>', desc = 'Show or hide the sidebar' },
      { '<leader>E', '<cmd>Neotree reveal<cr>', desc = 'Find this file in the sidebar' },
    },
    opts = {
      -- neo-tree's resize monitor leaks. Its guard variable
      -- (resize_monitor_timer in ui/renderer.lua) is declared and tested but
      -- never assigned, so every tree render starts another immortal 50ms
      -- self-rescheduling loop. Left alone it reached ~28k live timers and
      -- pegged a CPU core for days. A negative interval returns before any
      -- timer is created, so the bug is unreachable rather than merely rare.
      -- Cost: the sidebar no longer auto-adjusts width on terminal resize.
      resize_timer_interval = -1,
      close_if_last_window = true,   -- do not leave a lone sidebar behind
      popup_border_style = 'rounded',
      enable_git_status = true,
      enable_diagnostics = false,    -- you are not compiling code, so no error marks
      sources = { 'filesystem' },    -- one source only, nothing to switch between
      default_component_configs = {
        indent = {
          with_expanders = true,     -- the ▸ / ▾ arrow next to every folder
          expander_collapsed = '',
          expander_expanded = '',
        },
        -- Colour the filename itself by its git state, the way VS Code does.
        name = {
          use_git_status_colors = true,
          highlight = 'NeoTreeFileName',
        },
        -- Letters, not icons. An icon that your font does not have is an
        -- invisible icon. A letter always shows up.
        --   M  changed since the last commit
        --   U  brand new, git has never seen it
        --   A  staged, ready to commit
        --   D  deleted      R  renamed      !  conflict
        -- A green ✓ after the letter means that change is staged, that is,
        -- already picked for the next commit. No ✓ means not staged yet.
        git_status = {
          symbols = {
            modified  = 'M',
            untracked = 'U',
            added     = 'A',
            deleted   = 'D',
            renamed   = 'R',
            conflict  = '!',
            ignored   = '',
            staged    = '✓',
            unstaged  = '',
          },
          align = 'right',
        },
      },
      window = {
        width = 34,
        mappings = {
          -- A single click opens the file or folds the folder, like VS Code.
          ['<LeftRelease>'] = function(state)
            if state.tree:get_node() then
              require('neo-tree.sources.filesystem.commands').open(state)
            end
          end,
          ['<cr>'] = 'open',
          ['<space>'] = 'none',      -- keep Space free as the leader key
          ['H'] = 'toggle_hidden',
          ['a'] = { 'add', config = { show_path = 'relative' } },
          ['q'] = 'close_window',

          -- Left at neo-tree's defaults, listed here so you know they exist:
          --   e        widen the sidebar to fit the longest name. Press again
          --            to go back. It is a toggle, not a one-way change.
          --   Ctrl-B   scroll a file preview, if one is open
          --   Ctrl-F   scroll a file preview the other way
        },
      },
      filesystem = {
        -- Backspace and . are left at neo-tree's defaults. They are each
        -- other's undo:
        --   Backspace  move the sidebar UP one folder, so you can see the
        --              folder your project sits in
        --   .          move it DOWN, making the folder under the cursor the
        --              new top of the tree
        -- If Backspace took you somewhere you did not want, put the cursor on
        -- your project folder and press . to come back.
        follow_current_file = { enabled = true },  -- sidebar tracks the open file
        use_libuv_file_watcher = true,             -- notices files changed outside
        hijack_netrw_behavior = 'open_current',    -- `nvim .` opens the tree
        -- Show everything. A file you cannot see is a file you cannot find.
        -- Gitignored files (scratch notes, .env, build output) are dimmed,
        -- not hidden. Press H in the sidebar to hide them again.
        filtered_items = {
          hide_dotfiles = false,
          hide_gitignored = false,
          never_show = { '.git', '.DS_Store', 'node_modules' },
        },
      },
    },
    config = function(_, opts)
      require('neo-tree').setup(opts)

      -- Keep the git letters honest. Without this the sidebar keeps showing the
      -- state from when it was opened, so a file you just saved or committed
      -- still looks unchanged.
      vim.api.nvim_create_autocmd({ 'BufWritePost', 'FocusGained' }, {
        callback = function()
          pcall(function()
            require('neo-tree.sources.manager').refresh('filesystem')
          end)
        end,
      })
      vim.api.nvim_create_autocmd('User', {
        pattern = { 'NeogitStatusRefreshed', 'NeogitCommitComplete', 'NeogitPushComplete' },
        callback = function()
          pcall(function()
            require('neo-tree.sources.manager').refresh('filesystem')
          end)
        end,
      })

      -- Open the sidebar automatically when you start Neovim on a file, the
      -- way VS Code always has its explorer open. The cursor stays in the
      -- file, not in the tree. Starting with no file shows the dashboard
      -- instead, so the sidebar stays out of the way there.
      vim.api.nvim_create_autocmd('VimEnter', {
        once = true,
        callback = function()
          local arg = vim.fn.argv(0)
          if type(arg) == 'string' and arg ~= '' and vim.fn.isdirectory(arg) == 0 then
            vim.schedule(function() vim.cmd('Neotree show') end)
          end
        end,
      })
    end,
  },
}
