return {
  {
    'folke/snacks.nvim',
    priority = 1000,
    lazy = false,
    opts = {
      picker = {
        enabled = true,
        layout = { preset = 'select', preview = false },
        win = {
          input = { keys = { ['<Esc>'] = { 'close', mode = { 'n', 'i' } } } },
          list = { keys = { ['<LeftRelease>'] = 'confirm', ['<Esc>'] = 'close' } },
        },
        on_show = function(picker)
          if picker.opts.source == 'select' then vim.cmd.stopinsert() end
          local reader = require('reader')
          reader.panel = {
            kind = picker.opts.reader_action or picker.opts.source,
            picker = picker, close = function() picker:close() end,
            search = picker.opts.source == 'files' or picker.opts.source == 'grep',
          }
          -- ui.select owns its on_close callback; preserve it while clearing the toolbar.
          local on_close = picker.opts.on_close
          picker.opts.on_close = function(closed)
            if reader.panel and reader.panel.picker == closed then reader.panel = nil end
            if on_close then on_close(closed) end
            vim.schedule(reader.refresh_controls)
          end
          reader.refresh_controls()
        end,
      },
      input = {
        enabled = true,
        icon = '',
        win = {
          noautocmd = false,
          keys = { i_esc = { '<Esc>', 'cancel', mode = 'i' } },
          on_win = function(win)
            require('reader').panel = {
              kind = 'input', input = win, close = function() win:execute('cancel') end,
              submit = function() win:execute('confirm') end,
            }
            require('reader').refresh_controls()
            vim.schedule(function()
              if win:valid() then
                vim.api.nvim_win_call(win.win, function()
                  vim.wo.statusline = require('lualine').statusline(true)
                end)
              end
            end)
          end,
          on_close = function(win)
            local reader = require('reader')
            if reader.panel and reader.panel.input == win then reader.panel = nil end
            vim.schedule(reader.refresh_controls)
          end,
        },
      },
      notifier = { enabled = true },
      bigfile = { enabled = true },
      bufdelete = { enabled = true },
      dashboard = { enabled = false },
    },
  },
}
