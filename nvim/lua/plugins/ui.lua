local reader = require('reader')
local branches = require('branch-browser')
local function button(label, action, condition, red)
  return { type(label) == 'function' and label or function() return label end,
    on_click = function(...)
      vim.cmd.stopinsert()
      return action(...)
    end, cond = condition, padding = 1, color = red and { fg = 'red' } or nil }
end
local function wide() return vim.o.columns >= 125 end
local function working() return wide() and not reader.panel and not reader.view end
local function document()
  local buf = reader.file_buffer()
  return working() and reader.is_editable_file(buf)
end
local function context()
  if reader.view then return 'Reading branch: ' .. reader.view.name end
  return reader.working_branch
end

local function reading_filename()
  local path = vim.api.nvim_buf_get_name(0)
  local root = reader.reading_root()
  local name = path:sub(1, #root + 1) == root .. '/' and path:sub(#root + 2) or vim.fs.basename(path)
  return name .. (vim.bo.modified and ' ● Unsaved' or '')
end

return {
  { 'folke/which-key.nvim', lazy = false, opts = { preset = 'helix', delay = 200 } },
  {
    'akinsho/bufferline.nvim',
    dependencies = { 'nvim-tree/nvim-web-devicons' },
    lazy = false,
    config = function()
      require('bufferline').setup({
        highlights = {
          close_button = { fg = 'red', ctermfg = 1 }, close_button_visible = { fg = 'red', ctermfg = 1 }, close_button_selected = { fg = 'red', ctermfg = 1 },
        },
        options = {
          mode = 'buffers', diagnostics = false, always_show_bufferline = true,
          close_command = reader.close_file, right_mouse_command = reader.close_file, middle_mouse_command = reader.close_file,
          show_buffer_close_icons = true, show_close_icon = false, buffer_close_icon = '×', modified_icon = '●',
          separator_style = 'thin', hover = { enabled = false },
          custom_filter = function(buf)
            local path = vim.api.nvim_buf_get_name(buf)
            if path == '' then return false end
            if not reader.view then return true end
            return path:sub(1, #reader.view.root + 1) == reader.view.root .. '/'
          end,
          offsets = { { filetype = 'neo-tree', text = 'Files', text_align = 'left', separator = true } },
        },
      })
    end,
  },
  {
    'nvim-lualine/lualine.nvim',
    lazy = false,
    opts = {
      options = {
        globalstatus = true, component_separators = '', section_separators = '',
        always_divide_middle = false, disabled_filetypes = { winbar = { 'neo-tree' } },
      },
      sections = {
        lualine_a = { button('Sidebar', function() reader.show_sidebar(true) end), button('Search', function() reader.search_files() end),
          button('Branches', branches.choose_branch, function() return reader.is_repository end), button('More', reader.more_actions),
          button(function() local label = reader.markdown_view_label(); return label == 'Source' and 'Source   ' or label end,
            reader.toggle_markdown_view, function() return reader.markdown_view_label() ~= nil end) },
        lualine_b = { button('Edit', reader.edit_file, document),
          button('Save', reader.save_file, function() return document() and reader.is_editing_file(reader.file_buffer()) end),
          button('Push', branches.push_branch, function() return working() and reader.is_repository end),
          button('Back', branches.return_to_working, function() return wide() and reader.view ~= nil end),
          button('Switch project', branches.switch_branch, function() return wide() and reader.view ~= nil end) },
        lualine_c = {
          button('File names', function() reader.search_files('files') end, function() return reader.panel and reader.panel.search end),
          button('File contents', function() reader.search_files('grep') end, function() return reader.panel and reader.panel.search end),
          button('Submit', function() reader.panel.submit() end, function() return reader.panel ~= nil and reader.panel.submit ~= nil end),
        },
        lualine_x = {
          button('File actions', reader.file_actions, function() return wide() and not reader.view end),
          button('Help', reader.open_help, wide),
        },
        lualine_y = { button('Close', reader.close_action, nil, true) },
        lualine_z = { button('Quit', reader.quit_reader, nil, true) },
      },
      winbar = { lualine_c = { { context, color = { gui = 'bold' } }, reading_filename } },
      inactive_winbar = { lualine_c = { context, reading_filename } },
    },
  },
}
