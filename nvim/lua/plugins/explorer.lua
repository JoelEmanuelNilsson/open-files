return {
  {
    'nvim-neo-tree/neo-tree.nvim',
    dependencies = { 'nvim-lua/plenary.nvim', 'nvim-tree/nvim-web-devicons', 'MunifTanjim/nui.nvim' },
    lazy = false,
    opts = {
      -- The installed resize monitor leaks timers; disabling it prevents the leak.
      resize_timer_interval = -1,
      close_if_last_window = false,
      use_popups_for_input = false,
      enable_git_status = true,
      enable_diagnostics = false,
      sources = { 'filesystem' },
      default_component_configs = {
        indent = { with_expanders = true, expander_collapsed = '▸', expander_expanded = '▾' },
        name = { use_git_status_colors = true },
        git_status = { symbols = { modified = 'M', untracked = 'U', added = 'A', deleted = 'D',
          renamed = 'R', conflict = '!', ignored = '', staged = '', unstaged = '' } },
      },
      window = {
        width = 30,
        mappings = {
          ['<LeftRelease>'] = function(state)
            if state.tree:get_node() then require('neo-tree.sources.filesystem.commands').open(state) end
          end,
          ['<cr>'] = 'open', ['<space>'] = 'none', ['q'] = 'close_window',
          ['H'] = 'none',
          ['?'] = function() require('reader').file_actions() end,
          ['<bs>'] = 'none', ['.'] = 'none',
        },
      },
      filesystem = {
        bind_to_cwd = false,
        follow_current_file = { enabled = true },
        use_libuv_file_watcher = true,
        hijack_netrw_behavior = 'disabled',
        filtered_items = {
          hide_dotfiles = false, hide_gitignored = true, hide_ignored = true,
          ignore_files = { '.ignore', '.rgignore' },
          hide_by_name = require('reader').hidden_names,
          never_show = { '.git' },
        },
      },
    },
    config = function(_, opts)
      local reader = require('reader')
      local commands = require('neo-tree.sources.filesystem.commands')
      opts.filesystem.commands = {}
      for _, name in ipairs({ 'add', 'add_directory', 'copy', 'move', 'rename', 'delete', 'delete_visual',
        'trash', 'trash_visual', 'cut_to_clipboard', 'cut_to_clipboard_visual', 'paste_from_clipboard', 'undo' }) do
        local command = commands[name]
        if command then
          opts.filesystem.commands[name] = function(state, ...)
            if reader.view then return vim.notify('File actions are unavailable while browsing a branch.') end
            return command(state, ...)
          end
        end
      end
      require('neo-tree').setup(opts)
      -- Neo-tree's confirmation seam uses the same mouse-first choices as Git.
      require('neo-tree.ui.inputs').confirm = function(message, callback)
        if not callback then return vim.fn.confirm(message, '&Cancel\n&Confirm', 1) == 2 end
        reader.close_panel()
        vim.ui.select({ 'Cancel', 'Confirm' }, { prompt = message }, function(choice) callback(choice == 'Confirm') end)
      end
      vim.api.nvim_create_autocmd({ 'BufWritePost', 'FocusGained' }, { callback = function()
        require('neo-tree.sources.manager').refresh('filesystem')
      end })
    end,
  },
}
