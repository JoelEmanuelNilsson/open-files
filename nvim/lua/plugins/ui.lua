return {
  -- Press Space and a menu shows what every next key does.
  {
    'folke/which-key.nvim',
    lazy = false,
    opts = {
      preset = 'helix',   -- the panel that slides in on the right when you press Space
      delay = 200,
      spec = {
        -- Hide the nine "go to file N" entries behind one line in the menu.
        { '<leader>1', desc = 'Go to file 1..9', icon = '󰈔' },
        { '<leader>2', hidden = true },
        { '<leader>3', hidden = true },
        { '<leader>4', hidden = true },
        { '<leader>5', hidden = true },
        { '<leader>6', hidden = true },
        { '<leader>7', hidden = true },
        { '<leader>8', hidden = true },
        { '<leader>9', hidden = true },
      },
    },
  },

  -- The row of tabs across the top: one per open file.
  -- A ● instead of the x means the file has unsaved changes.
  {
    'akinsho/bufferline.nvim',
    dependencies = { 'nvim-tree/nvim-web-devicons' },
    lazy = false,
    config = function()
      require('bufferline').setup({
        options = {
          mode = 'buffers',
          close_command = function(n) Snacks.bufdelete(n) end,
          right_mouse_command = function(n) Snacks.bufdelete(n) end,
          middle_mouse_command = function(n) Snacks.bufdelete(n) end,
          diagnostics = false,
          always_show_bufferline = true,
          show_buffer_close_icons = true,
          show_close_icon = false,
          separator_style = 'thin',
          modified_icon = '●',
          hover = { enabled = true, delay = 120, reveal = { 'close' } },
          -- Keep the start screen and leftover empty buffers out of the tabs.
          custom_filter = function(buf)
            if vim.bo[buf].filetype == 'snacks_dashboard' then return false end
            if vim.api.nvim_buf_get_name(buf) == '' and not vim.bo[buf].modified then
              return false
            end
            return true
          end,
          -- Keeps the tabs clear of the sidebar and gives it a title.
          offsets = {
            {
              filetype = 'neo-tree',
              text = '  EXPLORER',
              text_align = 'left',
              highlight = 'Directory',
              separator = true,
            },
          },
        },
      })
    end,
  },

  -- The bar at the bottom: mode, git branch, filename, saved or not.
  {
    'nvim-lualine/lualine.nvim',
    dependencies = { 'nvim-tree/nvim-web-devicons' },
    lazy = false,
    opts = {
      options = {
        globalstatus = true,
        component_separators = '',
        section_separators = { left = '', right = '' },
      },
      sections = {
        lualine_a = { 'mode' },
        lualine_b = { 'branch', { 'diff', symbols = { added = ' ', modified = ' ', removed = ' ' } } },
        lualine_c = {
          {
            'filename',
            path = 1,                      -- show the path relative to the project
            symbols = {
              modified = '  ●  UNSAVED',
              readonly = '  ',
              newfile  = '  NEW',
            },
          },
        },
        lualine_x = {
          -- Word count, but only while you are writing markdown.
          {
            function() return '󰈭 ' .. vim.fn.wordcount().words .. ' words' end,
            cond = function() return vim.bo.filetype == 'markdown' end,
          },
        },
        -- Back and forward, like a browser. Click them, or press the key
        -- printed next to each arrow. They walk the list of places you
        -- jumped from, so you can leave a file and come straight back.
        -- The keys used to read º and ç; AeroSpace grabs those two at the OS
        -- level now, so the arrows advertise Neovim's own names again.
        lualine_y = {
          {
            function() return '  ^O' end,
            on_click = function() vim.cmd('normal! \15') end,   -- \15 is Ctrl-O
          },
          {
            function() return '  ^I' end,
            on_click = function() vim.cmd('normal! \9') end,    -- \9 is Ctrl-I
          },
        },
        -- Spelled out, the way VS Code does it, instead of "9:12".
        lualine_z = {
          {
            function()
              local line, col = unpack(vim.api.nvim_win_get_cursor(0))
              return string.format('Ln %d, Col %d', line, col + 1)
            end,
          },
        },
      },
    },
  },
}
