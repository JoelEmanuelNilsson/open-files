-- Reader controls share one project and one reading pane; plugins keep their own UI.
local M = { view = nil, panel = nil }
M.hidden_names = { '.DS_Store', 'node_modules', '.cache', '.next', '.turbo', '.venv', '__pycache__', 'coverage', 'dist', 'build', 'target' }
local preference_file = vim.fn.stdpath('state') .. '/reader.json'
local function read_preferences()
  local ok, value = pcall(function()
    return vim.json.decode(table.concat(vim.fn.readfile(preference_file), '\n'))
  end)
  return ok and type(value) == 'table' and value or {}
end
local preferences = read_preferences()
-- Markdown view is remembered across documents and editor launches.
M.markdown_view = preferences.formatted == false and 'source' or 'formatted'

local arg = vim.fn.argv(0)
local start = type(arg) == 'string' and arg ~= '' and vim.fn.fnamemodify(arg, ':p') or vim.fn.getcwd()
if vim.fn.isdirectory(start) == 0 then start = vim.fs.dirname(start) end
local result = vim.system({ 'git', '-C', start, 'rev-parse', '--show-toplevel' }, { text = true }):wait()
M.is_repository = result.code == 0
M.project_root = vim.fs.normalize(M.is_repository and vim.trim(result.stdout) or start)
M.working_branch = ''

local function persist_preferences()
  local latest = read_preferences()
  latest.formatted = M.markdown_view == 'formatted'
  if M.last_file then
    if type(latest.projects) ~= 'table' then latest.projects = {} end
    latest.projects[M.project_root] = M.last_file
  end
  vim.fn.mkdir(vim.fs.dirname(preference_file), 'p')
  local temp = preference_file .. '.' .. vim.fn.getpid()
  vim.fn.writefile({ vim.json.encode(latest) }, temp)
  assert(vim.uv.fs_rename(temp, preference_file))
end

-- The active root is a temporary committed snapshot only while browsing a branch.
function M.reading_root() return M.view and M.view.root or M.project_root end

-- Resolve the reading pane even when a sidebar or search popup has focus.
function M.file_window()
  if M.reading_win and vim.api.nvim_win_is_valid(M.reading_win) then return M.reading_win end
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if vim.api.nvim_win_get_config(win).relative == '' and vim.bo[vim.api.nvim_win_get_buf(win)].buftype == '' then
      M.reading_win = win
      return win
    end
  end
end

-- Return the file buffer, not the buffer of a currently focused popup.
function M.file_buffer()
  local win = M.file_window()
  return win and vim.api.nvim_win_get_buf(win)
end

-- Render controls after the current action's window changes finish.
function M.refresh_controls()
  vim.schedule(function() require('lualine').refresh({ force = true }) end)
end

-- Close controls dismiss a panel before they close a document.
function M.close_panel()
  if not M.panel then return false end
  local panel = M.panel
  M.panel = nil
  panel.close()
  M.refresh_controls()
  return true
end

-- Toggle a panel; its opener returns the picker so pending displays can be cancelled.
function M.toggle_panel(kind, show)
  local active = M.panel and M.panel.kind == kind
  M.close_panel()
  if active then return end
  local request = { kind = kind }
  local picker
  request.close = function()
    if picker then picker:close() end
  end
  M.panel = request
  vim.schedule(function()
    if M.panel ~= request then return end
    picker = show()
    if M.panel == request then
      if picker then request.picker = picker else M.panel = nil end
    elseif picker and (not M.panel or M.panel.picker ~= picker) then picker:close() end
    M.refresh_controls()
  end)
end

-- All choices use the same clickable result list; Escape cancels.
function M.choose_action(title, items, callback, kind)
  M.close_panel()
  M.toggle_panel(kind or 'choice', function()
    return vim.ui.select(items, { prompt = title, snacks = { reader_action = kind or 'choice' } }, function(item) if item then callback(item) end end)
  end)
end

-- Confirm dangerous actions with Cancel selected by default.
function M.confirm_action(title, label, callback)
  M.choose_action(title, { 'Cancel', label }, function(item) if item == label then callback() end end)
end

-- Open a file in the reading pane without replacing the sidebar.
function M.open_file(path)
  vim.cmd.stopinsert()
  M.close_panel()
  local win = M.file_window()
  if not win then return end
  vim.api.nvim_set_current_win(win)
  path = vim.uv.fs_realpath(path) or vim.fn.fnamemodify(path, ':p')
  local buf = vim.fn.bufnr(path)
  if buf >= 0 then vim.api.nvim_win_set_buf(win, buf)
  else vim.cmd('hide edit ' .. vim.fn.fnameescape(path)) end
  M.refresh_controls()
end

-- Refresh the fixed-root sidebar without changing Neovim's working directory.
function M.show_sidebar(toggle)
  require('neo-tree').ensure_config()
  local manager = require('neo-tree.sources.manager')
  local renderer = require('neo-tree.ui.renderer')
  local state = manager.get_state('filesystem')
  if toggle and renderer.close(state) then return end
  if renderer.window_exists(state) and state.path == M.reading_root() and not state.dirty then return end
  state._no_focus = true
  manager.navigate(state, M.reading_root(), nil, nil, false)
end

function M.reset_sidebar()
  require('neo-tree.sources.manager').dispose('filesystem', vim.api.nvim_get_current_tabpage())
  M.show_sidebar()
end

-- Project file names come from the fsearch index (the one Raycast queries), so gitignored
-- folders such as .scratch are searchable; only .git and node_modules are left out.
-- Branch snapshots are written just before browsing, ahead of fsearch's index, so they list with rg.
local function fsearch_file_names(opts, ctx)
  local root = vim.uv.fs_realpath(opts.cwd) or opts.cwd
  local query = { 'in:' .. root, '!.git$', '!node_modules$', 'kind:file', 'limit:300', ctx.filter.search }
  return require('snacks.picker.source.proc').proc(ctx:opts({
    cmd = vim.fn.expand('~/.local/bin/fsearch'), args = { table.concat(query, ' ') },
    transform = function(item)
      item.cwd, item.file = root, item.text:sub(#root + 2)
    end,
  }), ctx)
end

-- File contents share the sidebar's hidden-file policy.
function M.search_files(kind, pattern)
  if kind then M.close_panel() end
  M.toggle_panel('search', function()
    M.search_kind = kind or M.search_kind or 'files'
    local exclude = { '.git' }
    vim.list_extend(exclude, M.hidden_names)
    local opts = {
      cwd = M.reading_root(), hidden = true, ignored = false, exclude = exclude,
      cmd = 'rg', regex = false, reader_action = 'search', title = M.search_kind == 'grep' and 'File contents' or 'File names',
    }
    if M.search_kind == 'grep' then
      opts.search = pattern
    elseif M.view then
      opts.pattern = pattern
    else
      opts.finder, opts.live, opts.search = fsearch_file_names, true, pattern
    end
    return Snacks.picker[M.search_kind](opts)
  end)
end

-- Only .md and .txt documents outside branch snapshots may be edited.
function M.is_editable_file(buf)
  if M.view or not buf or vim.bo[buf].buftype ~= '' then return false end
  local extension = vim.api.nvim_buf_get_name(buf):lower():match('%.([^./]+)$')
  return extension == 'md' or extension == 'txt'
end

-- Editing belongs to the document, not the currently focused dialog.
function M.is_editing_file(buf)
  return M.is_editable_file(buf) and vim.bo[buf].modifiable
end

local function save_document(buf)
  if not M.is_editable_file(buf) then
    vim.notify('Only .md and .txt files can be edited.', vim.log.levels.WARN)
    return false
  end
  vim.cmd.stopinsert()
  local ok, err = pcall(vim.api.nvim_buf_call, buf, function() vim.cmd.write() end)
  if not ok then
    vim.notify(tostring(err), vim.log.levels.ERROR)
    return false
  end
  vim.bo[buf].readonly, vim.bo[buf].modifiable = true, false
  M.refresh_controls()
  return true
end

-- Repeating Edit finishes editing; source files and snapshots stay read-only.
function M.edit_file()
  local buf = M.file_buffer()
  if not M.is_editable_file(buf) then return vim.notify('Only .md and .txt files can be edited.', vim.log.levels.WARN) end
  if M.is_editing_file(buf) then return M.stop_editing() end
  local win = M.file_window()
  M.close_panel()
  vim.api.nvim_set_current_win(win)
  vim.bo[buf].readonly, vim.bo[buf].modifiable = false, true
  vim.cmd.startinsert()
  M.refresh_controls()
end

-- Save successfully before returning a document to read-only mode.
function M.save_file()
  local buf = M.file_buffer()
  if M.is_editing_file(buf) then return save_document(buf) end
end

-- Finish editing without closing the document; dirty edits require a choice.
function M.stop_editing()
  local buf = M.file_buffer()
  if not M.is_editing_file(buf) then return end
  vim.cmd.stopinsert()
  if not vim.bo[buf].modified then
    vim.bo[buf].readonly, vim.bo[buf].modifiable = true, false
    M.refresh_controls()
    return
  end
  M.choose_action('Unsaved changes: ' .. vim.fs.basename(vim.api.nvim_buf_get_name(buf)),
    { 'Cancel', 'Save changes', 'Discard changes' }, function(choice)
      if choice == 'Cancel' then
        vim.api.nvim_set_current_win(M.file_window())
        vim.cmd.startinsert()
      elseif choice == 'Save changes' then save_document(buf)
      else
        local ok, err = pcall(vim.api.nvim_buf_call, buf, function() vim.cmd('edit!') end)
        if not ok then return vim.notify(tostring(err), vim.log.levels.ERROR) end
        vim.bo[buf].readonly, vim.bo[buf].modifiable = true, false
      end
      M.refresh_controls()
    end, 'edit')
end

-- Close a dialog or finish editing; only explicit tab closure removes a document.
function M.close_action()
  vim.cmd.stopinsert()
  if M.close_panel() then return end
  if M.is_editing_file(M.file_buffer()) then return M.stop_editing() end
end

-- Closing the last file leaves an empty reading pane, never quits Neovim.
function M.close_file(buf)
  vim.cmd.stopinsert()
  if not buf and M.close_panel() then return end
  buf = buf or M.file_buffer()
  if not buf or not vim.api.nvim_buf_is_valid(buf) then return end
  local function close()
    Snacks.bufdelete(buf)
    M.refresh_controls()
  end
  if not vim.bo[buf].modified then return close() end
  M.choose_action('Unsaved changes: ' .. vim.fs.basename(vim.api.nvim_buf_get_name(buf)),
    { 'Cancel', 'Save and close', 'Discard and close' }, function(choice)
      if choice == 'Cancel' then return end
      if choice == 'Save and close' then
        if not save_document(buf) then return end
      else
        vim.bo[buf].modified = false
      end
      close()
    end)
end

-- Quit asks about unsaved documents using clickable choices.
function M.quit_reader()
  local modified = false
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do modified = modified or vim.bo[buf].modified end
  if not modified then return vim.cmd.qall() end
  M.choose_action('Unsaved changes', { 'Cancel', 'Save all and quit', 'Discard all and quit' }, function(choice)
    if choice == 'Save all and quit' then
      local ok, err = pcall(vim.cmd, 'wall | qall')
      if not ok then vim.notify(tostring(err), vim.log.levels.ERROR) end
    elseif choice == 'Discard all and quit' then vim.cmd('qall!') end
  end)
end

-- Return the remembered Markdown view only when the document is Markdown.
function M.markdown_view_label()
  local buf = M.file_buffer()
  if not buf or vim.bo[buf].filetype ~= 'markdown' then return end
  return M.markdown_view == 'formatted' and 'Formatted' or 'Source'
end

-- Switch Markdown presentation without changing document contents or editing state.
function M.toggle_markdown_view()
  if not M.markdown_view_label() then return end
  M.markdown_view = M.markdown_view == 'formatted' and 'source' or 'formatted'
  require('render-markdown').set(M.markdown_view == 'formatted')
  persist_preferences()
  if M.is_editing_file(M.file_buffer()) then
    vim.api.nvim_set_current_win(M.file_window())
    vim.cmd.startinsert()
  end
  M.refresh_controls()
end

-- File actions operate on the selected sidebar item and are disabled in snapshots.
function M.file_actions()
  M.toggle_panel('file-actions', function()
    if M.view then
      vim.notify('File actions are unavailable while browsing a branch.')
      return
    end
    require('neo-tree.command').execute({ action = 'focus', dir = M.project_root })
    local state = require('neo-tree.sources.manager').get_state('filesystem')
    local node = state.tree and state.tree:get_node()
    if not node then return end
    local actions = { ['New file'] = 'add', ['New folder'] = 'add_directory', Rename = 'rename', Move = 'move', Delete = 'delete' }
    return vim.ui.select({ 'New file', 'New folder', 'Rename', 'Move', 'Delete' },
      { prompt = 'File actions: ' .. node.name, snacks = { reader_action = 'file-actions' } }, function(choice)
      if not choice or M.view or not vim.api.nvim_win_is_valid(state.winid) then return end
      vim.api.nvim_set_current_win(state.winid)
      state.config = { show_path = 'relative' }
      require('neo-tree.sources.filesystem.commands')[actions[choice]](state)
    end)
  end)
end

function M.open_help() M.open_file(vim.fn.stdpath('config') .. '/CHEATSHEET.md') end

-- Smaller terminals keep secondary controls in a visible More menu.
function M.more_actions()
  M.toggle_panel('more', function()
    local branches = require('branch-browser')
    local actions = {}
    local buf = M.file_buffer()
    if M.markdown_view_label() then
      table.insert(actions, { M.markdown_view == 'formatted' and 'Show source' or 'Show formatted', M.toggle_markdown_view })
    end
    if M.view then
      table.insert(actions, { 'Back', branches.return_to_working })
      table.insert(actions, { 'Switch project', branches.switch_branch })
    else
      if M.is_repository then table.insert(actions, { 'Push', branches.push_branch }) end
      if M.is_editable_file(buf) then
        table.insert(actions, { 'Edit', M.edit_file })
        if M.is_editing_file(buf) then table.insert(actions, { 'Save', M.save_file }) end
      end
      table.insert(actions, { 'File actions', M.file_actions })
    end
    table.insert(actions, { 'Help', M.open_help })
    return vim.ui.select(actions, { prompt = 'More', snacks = { reader_action = 'more' }, format_item = function(item) return item[1] end }, function(item)
      if item then item[2]() end
    end)
  end)
end

-- Install read-only defaults and restore just the last working file, not editor sessions.
function M.setup_reader()
  local group = vim.api.nvim_create_augroup('ProjectReader', { clear = true })
  vim.api.nvim_create_autocmd({ 'BufReadPost', 'BufNewFile' }, { group = group, callback = function(event)
    if vim.bo[event.buf].buftype == '' then
      vim.bo[event.buf].readonly, vim.bo[event.buf].modifiable = true, false
    end
  end })
  vim.api.nvim_create_autocmd('BufEnter', { group = group, callback = function(event)
    if vim.bo[event.buf].buftype ~= '' or vim.api.nvim_win_get_config(0).relative ~= '' then return end
    M.reading_win = vim.api.nvim_get_current_win()
  end })
  local function remember_file()
    local buf = M.file_buffer()
    if not buf or M.view then return end
    local path = vim.api.nvim_buf_get_name(buf)
    if path:sub(1, #M.project_root + 1) == M.project_root .. '/' and vim.fn.filereadable(path) == 1 then
      M.last_file = { path = path, cursor = vim.api.nvim_win_get_cursor(M.file_window()) }
    end
  end
  M.remember_file = remember_file
  vim.api.nvim_create_autocmd('BufLeave', { group = group, callback = remember_file })
  vim.api.nvim_create_autocmd('VimLeavePre', { group = group, callback = function()
    remember_file()
    persist_preferences()
    if M.view then vim.fn.delete(M.view.temp, 'rf') end
  end })
  vim.api.nvim_create_autocmd('VimEnter', { group = group, once = true, callback = function()
    vim.schedule(function()
      if vim.fn.argc() == 1 and vim.fn.isdirectory(vim.fn.argv(0)) == 1 then
        vim.cmd.enew()
        M.reading_win = vim.api.nvim_get_current_win()
      end
      local last = type(preferences.projects) == 'table' and preferences.projects[M.project_root]
      if (vim.fn.argc() == 0 or vim.fn.isdirectory(vim.fn.argv(0)) == 1) and type(last) == 'table'
        and type(last.path) == 'string' and last.path:sub(1, #M.project_root + 1) == M.project_root .. '/'
        and vim.fn.filereadable(last.path) == 1 then
        M.open_file(last.path)
        if type(last.cursor) == 'table' then pcall(vim.api.nvim_win_set_cursor, M.file_window(), last.cursor) end
      end
      M.show_sidebar()
      require('branch-browser').refresh_branch()
    end)
  end })
  vim.api.nvim_create_autocmd('FocusGained', { group = group, callback = function()
    require('branch-browser').refresh_branch()
    vim.cmd.checktime()
  end })
end

return M
