local M = {}
local function label_text(text)
  return text:gsub('^%[', ''):gsub('%]$', ''):gsub('%s+', ' '):lower()
end
local function child_text(node, kind, buf)
  for child in node:iter_children() do
    if child:type() == kind then return vim.treesitter.get_node_text(child, buf) end
  end
end

-- Resolve Markdown links through the shipped parsers, including reference links.
function M.link_at_cursor(buf, position)
  local parser = vim.treesitter.get_parser(buf, 'markdown')
  parser:parse(true)
  local node = vim.treesitter.get_node({ bufnr = buf, pos = position, ignore_injections = false })
  while node do
    local kind = node:type()
    if kind == 'inline_link' then return child_text(node, 'link_destination', buf) end
    if kind == 'uri_autolink' then return vim.treesitter.get_node_text(node, buf):sub(2, -2) end
    if kind == 'email_autolink' then return 'mailto:' .. vim.treesitter.get_node_text(node, buf):sub(2, -2) end
    if kind == 'full_reference_link' or kind == 'collapsed_reference_link' or kind == 'shortcut_link' then
      local label = label_text(child_text(node, 'link_label', buf) or child_text(node, 'link_text', buf) or '')
      local query = vim.treesitter.query.parse('markdown', '(link_reference_definition (link_label) @label (link_destination) @destination)')
      for _, match in query:iter_matches(parser:trees()[1]:root(), buf, 0, -1) do
        if label_text(vim.treesitter.get_node_text(match[1][1], buf)) == label then
          return vim.treesitter.get_node_text(match[2][1], buf)
        end
      end
      return nil
    end
    node = node:parent()
  end
end

local function jump_heading(fragment)
  local counts = {}
  for line, text in ipairs(vim.api.nvim_buf_get_lines(0, 0, -1, false)) do
    local title = text:match('^%s*#+%s+(.+)')
    if title then
      local slug = title:lower():gsub('[^%w%s%-\128-\255]', ''):gsub('%s', '-')
      local count = counts[slug] or 0
      counts[slug] = count + 1
      if count > 0 then slug = slug .. '-' .. count end
      if slug == fragment then vim.api.nvim_win_set_cursor(0, { line, 0 }); return end
    end
  end
  vim.notify('Markdown heading not found: ' .. fragment, vim.log.levels.WARN)
end

-- Local document links stay in the viewed branch; web links use the default browser.
function M.open_link_target(target, source)
  local reader = require('reader')
  target = target:gsub('^<', ''):gsub('>$', '')
  if target:match('^https?://') or target:match('^mailto:') then
    local _, err = vim.ui.open(target, target:match('^https?://') and { cmd = { 'open', '-a', 'Google Chrome' } } or nil)
    if err then vim.notify(tostring(err), vim.log.levels.ERROR) end
    return
  end
  if target:match('^%a[%w+.-]*:') then return vim.notify('Unsupported link: ' .. target, vim.log.levels.WARN) end
  local path, fragment = target:match('^([^#]*)#?(.*)$')
  path, fragment = vim.uri_decode(path), vim.uri_decode(fragment)
  local root = reader.reading_root()
  local destination = path == '' and source or vim.fs.normalize(
    path:sub(1, 1) == '/' and (root .. path) or (vim.fs.dirname(source) .. '/' .. path))
  if reader.view then
    local resolved = vim.uv.fs_realpath(destination)
    local real_root = vim.uv.fs_realpath(root)
    if not resolved or not real_root or resolved:sub(1, #real_root + 1) ~= real_root .. '/' then
      return vim.notify('This link is outside the branch being browsed.', vim.log.levels.WARN)
    end
  end
  if vim.fn.filereadable(destination) ~= 1 then return vim.notify('Linked file not found: ' .. path, vim.log.levels.WARN) end
  reader.open_file(destination)
  if fragment ~= '' then jump_heading(fragment) end
end

-- Click to follow only in reading mode; dragging a selection does not open links.
function M.follow_link()
  if vim.bo.filetype ~= 'markdown' or vim.bo.modifiable or vim.fn.mode():match('[vV\22]') then return end
  local cursor = vim.api.nvim_win_get_cursor(0)
  local target = M.link_at_cursor(0, { cursor[1] - 1, cursor[2] })
  if target then M.open_link_target(target, vim.api.nvim_buf_get_name(0)) end
end

return M
