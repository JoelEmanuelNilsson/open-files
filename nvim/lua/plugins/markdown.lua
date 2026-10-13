return {
  {
    'MeanderingProgrammer/render-markdown.nvim',
    lazy = false,
    opts = {
      enabled = require('reader').markdown_view == 'formatted',
      debounce = 0,
      render_modes = { 'n', 'c', 'v', 'V', '\22' },
      anti_conceal = { enabled = false },
      heading = { icons = { '', '', '', '', '', '' }, sign = false },
      code = { sign = false },
      sign = { enabled = false },
      link = { hyperlink = '', image = '', email = '', custom = {} },
    },
    config = function(_, opts)
      -- The plugin renders only rows near the window, so a table's column widths depended
      -- on which of its rows were in view and changed while scrolling. Render whole documents.
      local View = require('render-markdown.request.view')
      local new_view = View.new
      function View.new(buf)
        local view = new_view(buf)
        assert(type(view.ranges) == 'table', 'render-markdown View no longer has ranges')
        view.ranges = { { 0, vim.api.nvim_buf_line_count(buf) } }
        return view
      end
      require('render-markdown').setup(opts)
      vim.api.nvim_create_autocmd('FileType', { pattern = 'markdown', callback = function(event)
        vim.opt_local.wrap = true
        vim.opt_local.linebreak = true
        vim.keymap.set('n', '<LeftRelease>', function() require('markdown-links').follow_link() end, { buffer = event.buf })
        vim.keymap.set('n', 'gx', function() require('markdown-links').follow_link() end, { buffer = event.buf, desc = 'Open Markdown link' })
      end })
      -- Hidden fence lines and wrapped table rows are conceal_lines marks, and Neovim's scroll
      -- shortcut leaves stale rows beside them, so a scrolled Markdown window redraws in full.
      vim.api.nvim_create_autocmd('WinScrolled', { callback = function()
        for id in pairs(vim.v.event) do
          local win = tonumber(id)
          if win and vim.api.nvim_win_is_valid(win) and vim.bo[vim.api.nvim_win_get_buf(win)].filetype == 'markdown' then
            vim.api.nvim__redraw({ win = win, valid = false })
          end
        end
      end })
    end,
  },
}
