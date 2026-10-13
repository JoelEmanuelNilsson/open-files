-- Run: nvim --headless -u NONE -l nvim/tests/reader.lua
local config = vim.fs.dirname(vim.fs.dirname(vim.fn.fnamemodify(debug.getinfo(1, 'S').source:sub(2), ':p')))
local temp = vim.fn.tempname()
local repo = temp .. '/project'
vim.fn.mkdir(repo .. '/docs', 'p')
vim.env.XDG_STATE_HOME = temp .. '/state'
vim.fn.mkdir(temp .. '/config', 'p')
vim.uv.fs_symlink(config, temp .. '/config/nvim')
vim.env.XDG_CONFIG_HOME = temp .. '/config'
vim.fn.mkdir(temp .. '/state/nvim', 'p')
vim.fn.writefile({ '{"formatted":false}' }, temp .. '/state/nvim/reader.json')
vim.o.shadafile = 'NONE'
vim.o.undodir = temp .. '/undo'
vim.fn.mkdir(temp .. '/undo', 'p')
local function command(args)
  local result = vim.system(args, { text = true }):wait()
  assert(result.code == 0, table.concat(args, ' ') .. ': ' .. (result.stderr or ''))
  return vim.trim(result.stdout)
end
local function git(...)
  local args = { 'git', '-C', repo }
  vim.list_extend(args, { ... })
  return command(args)
end
local function write(path, lines) vim.fn.writefile(lines, repo .. '/' .. path) end
local function wait_for(predicate, message)
  assert(vim.wait(10000, predicate, 10), message)
end
local messages = {}
local function failed_operations()
  local count = 0
  for _, message in ipairs(messages) do if message:find('Git operation failed:', 1, true) then count = count + 1 end end
  return count
end
local assertions = 0
local function check(value, message)
  assert(value, message)
  assertions = assertions + 1
end
local function select_choice(reader, text)
  wait_for(function() return reader.panel and reader.panel.picker and reader.panel.picker:count() > 0 end, 'No choice picker')
  local picker = reader.panel.picker
  wait_for(function() return not picker:is_active() end, 'Choice picker did not finish')
  for index, item in ipairs(picker:items()) do
    if item.text:find(text, 1, true) then
      picker.list:move(index, true, true)
      picker:action('confirm')
      return
    end
  end
  error('Choice not found: ' .. text)
end
local function run_tests()
  git('init', '-b', 'main')
  git('config', 'user.name', 'Reader Test')
  git('config', 'user.email', 'reader-test@example.invalid')
  write('README.md', { '# Main', '', '[Guide](docs/guide.md#details)', '', '[Reference][guide]', '', '[guide]: docs/guide.md' })
  write('docs/guide.md', { '# Details', '', 'Main guide' })
  write('main-only.md', { 'Only on main' })
  write('secret.md', { 'Committed, despite export-ignore' })
  write('expanded.md', { '$Format:%H$' })
  write('.gitattributes', { 'secret.md export-ignore', 'expanded.md export-subst' })
  write('.notes.md', { 'A dotfile' })
  write('.gitignore', { 'node_modules/', 'ignored.txt' })
  git('add', '.')
  git('commit', '-m', 'main')
  git('switch', '-c', 'feature')
  write('README.md', { '# Feature', '', '[Guide](docs/guide.md#details)' })
  write('docs/guide.md', { '# Details', '', 'Feature guide' })
  write('ignored.txt', { 'Tracked on feature' })
  git('add', '-f', 'ignored.txt')
  git('rm', 'main-only.md')
  git('add', '.')
  git('commit', '-m', 'feature')
  git('switch', 'main')
  write('ignored.txt', { 'A hidden ignored file' })
  vim.fn.mkdir(repo .. '/node_modules', 'p')
  write('node_modules/dependency.txt', { 'Not a project file' })
  vim.cmd.cd(repo)
  vim.opt.rtp:prepend(config)
  vim.o.loadplugins = true
  dofile(config .. '/init.lua')
  vim.api.nvim_exec_autocmds('VimEnter', {})
  local reader = require('reader')
  local branches = require('branch-browser')
  wait_for(function() return reader.working_branch == 'main' end, 'Startup did not finish')
  local notify = Snacks.notifier.notify
  vim.notify = function(message, level, opts)
    messages[#messages + 1] = tostring(message)
    return notify(message, level, opts)
  end
  reader.open_file(repo .. '/README.md')
  check(not vim.bo.modifiable and vim.bo.readonly, 'File must open read-only')
  reader.edit_file()
  check(vim.bo.modifiable and not vim.bo.readonly, 'Edit must enable typing')
  vim.cmd.stopinsert()
  vim.api.nvim_buf_set_lines(0, -1, -1, false, { 'An unsaved note' })
  local working_buf = vim.api.nvim_get_current_buf()
  reader.close_file()
  select_choice(reader, 'Cancel')
  wait_for(function() return not reader.panel end, 'Cancel did not dismiss panel')
  check(vim.api.nvim_buf_is_valid(working_buf) and vim.bo[working_buf].modified, 'Cancel must preserve edits')
  branches.browse_branch({ ref = 'refs/heads/feature', name = 'feature', local_name = 'feature' })
  wait_for(function() return reader.view ~= nil end, 'Branch snapshot not opened')
  check(git('branch', '--show-current') == 'main', 'Browsing changed working branch')
  check(vim.api.nvim_buf_get_lines(reader.file_buffer(), 0, 1, false)[1] == '# Feature', 'Wrong branch content')
  check(vim.bo[working_buf].modified, 'Browsing lost unsaved working edits')
  vim.fn.maparg('  ', 'n', false, true).callback()
  check(vim.api.nvim_buf_get_name(reader.file_buffer()):sub(1, #reader.view.root + 1) == reader.view.root .. '/',
    'Previous-file shortcut escaped the branch view')
  reader.close_file()
  check(vim.api.nvim_buf_get_name(reader.file_buffer()):sub(1, #reader.project_root + 1) ~= reader.project_root .. '/',
    'Closing a branch file displayed working content as branch content')
  reader.open_file(reader.view.root .. '/README.md')
  check(vim.fn.filereadable(reader.view.root .. '/secret.md') == 1, 'export-ignore hid a committed file')
  check(vim.fn.readfile(reader.view.root .. '/expanded.md')[1] == '$Format:%H$', 'export-subst rewrote committed content')
  reader.edit_file()
  check(not vim.bo[reader.file_buffer()].modifiable, 'Snapshot editing was enabled')
  local links = require('markdown-links')
  local target = links.link_at_cursor(reader.file_buffer(), { 2, 2 })
  check(target == 'docs/guide.md#details', 'Inline link resolution failed')
  links.open_link_target(target, vim.api.nvim_buf_get_name(reader.file_buffer()))
  check(vim.api.nvim_buf_get_lines(reader.file_buffer(), 2, 3, false)[1] == 'Feature guide', 'Document link escaped the branch')
  local snapshot_temp = reader.view.temp
  branches.return_to_working()
  check(reader.view == nil and not vim.uv.fs_stat(snapshot_temp), 'Snapshot was not cleaned up')
  check(vim.bo[working_buf].buflisted, 'Working tabs were not restored')
  reader.open_file(repo .. '/README.md')
  check(vim.api.nvim_get_current_buf() == working_buf and vim.bo.modified, 'Working buffer not preserved')
  check(links.link_at_cursor(working_buf, { 4, 2 }) == 'docs/guide.md', 'Reference link resolution failed')
  reader.save_file()
  check(not vim.bo.modifiable and not vim.bo.modified, 'Save must return to reading')
  check(vim.fn.readfile(repo .. '/README.md')[8] == 'An unsaved note', 'Save did not write edits')
  reader.search_files('files')
  wait_for(function() return reader.panel and reader.panel.picker and not reader.panel.picker:is_active() end, 'File search failed')
  local found = {}
  for _, item in ipairs(reader.panel.picker:items()) do found[item.file] = true end
  check(found['.notes.md'] and found['ignored.txt'] and not found['node_modules/dependency.txt'], 'Project filtering failed')
  reader.close_panel()
  reader.search_files('grep', '[Guide]')
  wait_for(function() return reader.panel and reader.panel.picker and not reader.panel.picker:is_active() end, 'Contents search failed')
  check(reader.panel.picker:count() > 0, 'Contents search did not match literal punctuation')
  reader.close_panel()
  for _ = 1, 20 do
    reader.search_files('files')
    wait_for(function() return reader.panel and reader.panel.picker and not reader.panel.picker:is_active() end, 'Repeated file search failed')
    reader.search_files('grep', '[Guide]')
    wait_for(function() return reader.panel and reader.panel.picker and not reader.panel.picker:is_active() end, 'Repeated contents search failed')
    local matches = {}
    for _, item in ipairs(reader.panel.picker:items()) do matches[#matches + 1] = item.file end
    check(vim.deep_equal(matches, { 'README.md' }), 'Repeated contents search lost its query')
    reader.close_panel()
  end
  for _ = 1, 20 do
    reader.search_files('files')
    reader.more_actions()
    reader.more_actions()
  end
  check(reader.panel == nil, 'Repeated actions must cancel pending menus')
  reader.more_actions()
  wait_for(function() return reader.panel and reader.panel.picker and not reader.panel.picker:is_active() end, 'More failed after pending cancellation')
  check(reader.panel.picker:items()[#reader.panel.picker:items()].item[1] == 'Help', 'Pending replacement lost More actions')
  reader.close_panel()
  check(reader.show_all == nil and reader.toggle_all_files == nil, 'Retired file filtering mode remains')
  check(not require('render-markdown').get() and reader.markdown_view_label() == 'Source', 'Saved Markdown source preference must be applied')
  reader.toggle_markdown_view()
  check(require('render-markdown').get() and reader.markdown_view_label() == 'Formatted', 'Markdown view must switch to formatted')
  local reading_buf = reader.file_buffer()
  reader.close_action()
  check(reader.file_buffer() == reading_buf and vim.bo[reading_buf].buflisted, 'Close must preserve a reading document')
  branches.browse_branch({ ref = 'refs/heads/feature', name = 'feature', local_name = 'feature' })
  wait_for(function() return reader.view ~= nil end, 'Second branch snapshot failed')
  branches.switch_branch()
  check(not reader.panel and git('branch', '--show-current') == 'main', 'Dirty repository switch was not refused')
  branches.return_to_working()
  git('add', 'README.md')
  git('commit', '-m', 'reader note')
  branches.browse_branch({ ref = 'refs/heads/feature', name = 'feature', local_name = 'feature' })
  wait_for(function() return reader.view ~= nil end, 'Third branch snapshot failed')
  local failures = failed_operations()
  branches.switch_branch()
  select_choice(reader, 'Switch project')
  wait_for(function() return failed_operations() > failures end, 'Ignored-file collision was not refused')
  check(git('branch', '--show-current') == 'main' and vim.fn.readfile(repo .. '/ignored.txt')[1] == 'A hidden ignored file',
    'Switch overwrote ignored data')
  vim.fn.delete(repo .. '/ignored.txt')
  branches.switch_branch()
  select_choice(reader, 'Switch project')
  wait_for(function() return reader.view == nil and reader.working_branch == 'feature' end, 'Confirmed switch failed')
  check(git('branch', '--show-current') == 'feature', 'Wrong working branch after switch')
  check(vim.api.nvim_buf_get_lines(reader.file_buffer(), 0, 1, false)[1] == '# Feature', 'Working file was stale after switch')
  command({ 'git', 'init', '--bare', temp .. '/remote.git' })
  git('remote', 'add', 'origin', temp .. '/remote.git')
  git('config', 'remote.origin.mirror', 'true')
  git('config', 'push.followTags', 'true')
  git('tag', '-a', 'not-requested', '-m', 'Do not push this tag')
  branches.push_branch()
  select_choice(reader, 'Push')
  wait_for(function()
    for _, message in ipairs(messages) do if message:find('Push complete:', 1, true) then return true end end
    return false
  end, 'Push did not finish')
  check(git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}') == 'origin/feature', 'Push did not set upstream')
  check(command({ 'git', '--git-dir=' .. temp .. '/remote.git', 'rev-parse', 'refs/heads/feature' }) == git('rev-parse', 'HEAD'), 'Push sent wrong commits')
  check(vim.system({ 'git', '--git-dir=' .. temp .. '/remote.git', 'show-ref', '--verify', '--quiet', 'refs/tags/not-requested' }):wait().code ~= 0,
    'Push included an unrequested tag')
  local remote_commit = command({ 'git', '--git-dir=' .. temp .. '/remote.git', '-c', 'user.name=Remote Test',
    '-c', 'user.email=remote@example.invalid', 'commit-tree', git('rev-parse', 'HEAD^{tree}'), '-p', git('rev-parse', 'HEAD'), '-m', 'remote-only commit' })
  command({ 'git', '--git-dir=' .. temp .. '/remote.git', 'update-ref', 'refs/heads/feature', remote_commit })
  failures = failed_operations()
  branches.push_branch()
  select_choice(reader, 'Push')
  wait_for(function() return failed_operations() > failures end, 'Non-fast-forward push was not refused')
  check(command({ 'git', '--git-dir=' .. temp .. '/remote.git', 'rev-parse', 'refs/heads/feature' }) == remote_commit,
    'Push overwrote remote commits')
  reader.close_file()
  check(reader.file_window() ~= nil, 'Closing document removed the reading pane')
  local stale_scan = false
  for _, message in ipairs(messages) do stale_scan = stale_scan or message:find('backing out', 1, true) ~= nil end
  check(not stale_scan, 'Disposed snapshot scan remained active')
  print('Reader integration: ' .. assertions .. ' assertions passed')
end
local ok, err = xpcall(run_tests, debug.traceback)
if not ok then io.stderr:write(err .. '\n' .. vim.inspect(messages) .. '\n') end
-- Only generated fixture data is removed; preferences never touch the real state directory.
vim.api.nvim_clear_autocmds({ group = 'ProjectReader', event = 'VimLeavePre' })
vim.fn.delete(temp, 'rf')
if not ok then vim.cmd('cquit 1') end
vim.cmd('qall!')
