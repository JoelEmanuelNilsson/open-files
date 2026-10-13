local reader = require('reader')
local M = {}
local busy = false

local function git_result(args)
  if vim.fn.isdirectory(reader.project_root) == 0 then
    return { code = 1, stdout = '', stderr = 'This folder no longer exists. Reopen Neovim in an existing folder.' }
  end
  local command = { 'git', '-C', reader.project_root }
  vim.list_extend(command, args)
  return vim.system(command, { text = true }):wait()
end
local function git_text(args)
  local result = git_result(args)
  if result.code ~= 0 then
    vim.notify('Git: ' .. vim.trim(result.stderr), vim.log.levels.ERROR)
    return nil
  end
  return vim.trim(result.stdout)
end
local function run_command(command, opts, callback)
  vim.system(command, opts or { text = true }, function(result)
    vim.schedule(function()
      if result.code ~= 0 then
        busy = false
        vim.notify('Git operation failed: ' .. vim.trim(result.stderr or ''), vim.log.levels.ERROR)
      end
      callback(result.code == 0, result)
    end)
  end)
end
local function working_buffers_clean()
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.bo[buf].buftype == '' and vim.bo[buf].modified then
      vim.notify('Save or close unsaved files before switching the project.', vim.log.levels.WARN)
      return false
    end
  end
  return true
end

-- Refresh the working branch independently of the committed branch being browsed.
function M.refresh_branch()
  local result = git_result({ 'symbolic-ref', '--quiet', '--short', 'HEAD' })
  if result.code == 0 then reader.working_branch = vim.trim(result.stdout)
  else
    result = git_result({ 'rev-parse', '--short', 'HEAD' })
    reader.working_branch = result.code == 0 and ('detached ' .. vim.trim(result.stdout)) or ''
  end
end

-- Return from a committed snapshot without changing or reloading working buffers.
function M.return_to_working()
  if busy then return vim.notify('A Git operation is still running.') end
  local view = reader.view
  if not view then return end
  local buf = reader.file_buffer()
  local path = buf and vim.api.nvim_buf_get_name(buf) or ''
  local relative = path:sub(1, #view.root + 1) == view.root .. '/' and path:sub(#view.root + 2) or nil
  reader.view = nil
  for _, working_buf in ipairs(view.hidden_buffers) do
    if vim.api.nvim_buf_is_valid(working_buf) then vim.bo[working_buf].buflisted = true end
  end
  reader.reset_sidebar()
  local destination = relative and (reader.project_root .. '/' .. relative) or nil
  if not destination or vim.fn.filereadable(destination) ~= 1 then
    destination = reader.last_file and reader.last_file.path
  end
  if destination and vim.fn.filereadable(destination) == 1 then reader.open_file(destination)
  else
    local win = reader.file_window()
    if win then vim.api.nvim_win_call(win, function() vim.cmd.enew() end) end
  end
  for _, snapshot_buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_get_name(snapshot_buf):sub(1, #view.root + 1) == view.root .. '/' then
      vim.api.nvim_buf_delete(snapshot_buf, { force = true })
    end
  end
  vim.fn.delete(view.temp, 'rf')
end

-- Browse exact committed content using a temporary archive, never a checkout or worktree.
function M.browse_branch(branch)
  if busy then return vim.notify('A Git operation is still running.') end
  if reader.view then M.return_to_working() end
  local commit = git_text({ 'rev-parse', '--verify', branch.ref .. '^{commit}' })
  local objects = git_text({ 'rev-parse', '--path-format=absolute', '--git-path', 'objects' })
  if not commit or not objects then return end
  reader.remember_file()
  local temp = vim.fn.tempname()
  local root = temp .. '/files'
  vim.fn.mkdir(root, 'p')
  root = assert(vim.uv.fs_realpath(root))
  busy = true
  vim.notify('Opening branch: ' .. branch.name)
  local function failed() vim.fn.delete(temp, 'rf') end
  -- Override archive attributes in a private Git directory, never in the project:
  -- export-ignore/export-subst must not omit files or rewrite committed contents.
  run_command({ 'git', 'init', '--bare', '--template=', temp .. '/git' }, nil, function(ok)
    if not ok then return failed() end
    vim.fn.mkdir(temp .. '/git/info', 'p')
    vim.fn.writefile({ '* -export-ignore -export-subst' }, temp .. '/git/info/attributes')
    run_command({ 'git', '--git-dir=' .. temp .. '/git',
      '-c', 'core.attributesFile=/dev/null', 'archive', '--format=tar',
      '--output=' .. temp .. '/branch.tar', commit },
      { text = true, env = { GIT_OBJECT_DIRECTORY = objects } }, function(archived)
        if not archived then return failed() end
        run_command({ 'tar', '-xf', temp .. '/branch.tar', '-C', root }, nil, function(extracted)
          busy = false
          if not extracted then return failed() end
          local hidden_buffers = {}
          for _, buf in ipairs(vim.api.nvim_list_bufs()) do
            if vim.bo[buf].buftype == '' and vim.bo[buf].buflisted then
              hidden_buffers[#hidden_buffers + 1] = buf
              vim.bo[buf].buflisted = false
            end
          end
          reader.view = { root = root, temp = temp, name = branch.name, ref = branch.ref,
            local_name = branch.local_name, commit = commit, hidden_buffers = hidden_buffers }
          reader.reset_sidebar()
          local relative = reader.last_file and reader.last_file.path:sub(#reader.project_root + 2)
          if relative and vim.fn.filereadable(root .. '/' .. relative) == 1 then reader.open_file(root .. '/' .. relative)
          else
            local win = reader.file_window()
            if win then vim.api.nvim_win_call(win, function() vim.cmd.enew() end) end
          end
        end)
      end)
  end)
end

-- Branch clicks browse; changing the working repository is a separate action.
function M.choose_branch()
  reader.toggle_panel('branches', function()
    if busy then
      vim.notify('A Git operation is still running.')
      return
    end
    local output = git_text({ 'for-each-ref', '--sort=-committerdate',
      '--format=%(refname)%09%(refname:short)%09%(symref)', 'refs/heads', 'refs/remotes' })
    if not output then return end
    local branches = {}
    for _, line in ipairs(vim.split(output, '\n', { trimempty = true })) do
      local fields = vim.split(line, '\t', { plain = true })
      if not fields[3] or fields[3] == '' then
        table.insert(branches, { ref = fields[1], name = fields[2],
          local_name = fields[1]:match('^refs/heads/(.+)$') })
      end
    end
    return vim.ui.select(branches, { prompt = 'Branches — click to read committed files', snacks = { reader_action = 'branches' }, format_item = function(branch)
      return branch.name .. (branch.local_name == reader.working_branch and '  (working branch)' or '')
    end }, function(branch) if branch then M.browse_branch(branch) end end)
  end)
end

-- Switch only clean projects, after confirmation; never stash, discard, or force.
function M.switch_branch()
  if busy then return vim.notify('A Git operation is still running.') end
  local view = reader.view
  if not view then return end
  if not working_buffers_clean() then return end
  local status = git_text({ 'status', '--porcelain', '--untracked-files=normal' })
  if not status then return end
  if status ~= '' then return vim.notify('Project has uncommitted changes. Switch refused; nothing was changed.', vim.log.levels.WARN) end
  reader.confirm_action('Switch project to ' .. view.name .. '? Agents in this folder will see the change.', 'Switch project', function()
    if reader.view ~= view or not working_buffers_clean() then return end
    local current = git_text({ 'status', '--porcelain', '--untracked-files=normal' })
    if current == nil then return end
    if current ~= '' then return vim.notify('Project changed while confirming. Switch refused.', vim.log.levels.WARN) end
    local args = { 'git', '-C', reader.project_root, 'switch', '--no-overwrite-ignore' }
    if view.local_name then vim.list_extend(args, { '--no-guess', '--', view.local_name })
    else vim.list_extend(args, { '--track', '--', view.ref:sub(#'refs/remotes/' + 1) }) end
    busy = true
    run_command(args, nil, function(ok)
      busy = false
      if not ok then return end
      -- Clean working buffers belong to the previous checkout. Reopen from disk;
      -- leave any edits made during the switch intact rather than discard them.
      for _, buf in ipairs(vim.api.nvim_list_bufs()) do
        if vim.api.nvim_buf_get_name(buf):sub(1, #reader.project_root + 1) == reader.project_root .. '/'
          and not vim.bo[buf].modified then vim.api.nvim_buf_delete(buf, { force = false }) end
      end
      M.return_to_working()
      M.refresh_branch()
      vim.notify('Project switched to ' .. reader.working_branch)
    end)
  end)
end

-- Push one explicit branch refspec; no staging, commits, configured mirror, or force-push.
function M.push_branch()
  if busy then return vim.notify('A Git operation is still running.') end
  local result = git_result({ 'symbolic-ref', '--quiet', '--short', 'HEAD' })
  if result.code ~= 0 then
    local message = vim.trim(result.stderr or '')
    return vim.notify(message ~= '' and ('Git: ' .. message) or 'Push needs a working branch, not a detached commit.', vim.log.levels.WARN)
  end
  local branch = vim.trim(result.stdout)
  local upstream = git_text({ 'for-each-ref', '--format=%(upstream:remotename)%09%(upstream:remoteref)', 'refs/heads/' .. branch })
  if not upstream then return end
  local parts = vim.split(upstream, '\t', { plain = true })
  local function push_to(remote, ref)
    if remote == '.' then return vim.notify('This branch tracks a local branch, not a remote.', vim.log.levels.WARN) end
    if not ref or not ref:match('^refs/heads/') then ref = 'refs/heads/' .. branch end
    local destination = remote .. '/' .. ref:sub(#'refs/heads/' + 1)
    reader.confirm_action('Push existing commits: ' .. branch .. ' → ' .. destination .. '?', 'Push', function()
      local head = git_result({ 'symbolic-ref', '--quiet', '--short', 'HEAD' })
      if head.code ~= 0 or vim.trim(head.stdout) ~= branch then return vim.notify('Working branch changed. Push cancelled.', vim.log.levels.WARN) end
      local command = { 'git', '-C', reader.project_root, '-c', 'remote.' .. remote .. '.mirror=false',
        'push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no' }
      if parts[1] == '' then table.insert(command, '--set-upstream') end
      vim.list_extend(command, { remote, 'refs/heads/' .. branch .. ':' .. ref })
      busy = true
      vim.notify('Pushing ' .. branch .. ' to ' .. destination .. '…')
      run_command(command, nil, function(ok, pushed)
        busy = false
        if ok then vim.notify('Push complete: ' .. destination .. '\n' .. vim.trim(pushed.stdout)) end
      end)
    end)
  end
  if parts[1] and parts[1] ~= '' then return push_to(parts[1], parts[2]) end
  local remotes = git_text({ 'remote' })
  if not remotes then return end
  local choices = vim.split(remotes, '\n', { trimempty = true })
  if #choices == 0 then return vim.notify('No remote configured for this project.', vim.log.levels.WARN) end
  if #choices == 1 then push_to(choices[1])
  else reader.choose_action('Push destination', choices, function(remote) push_to(remote) end) end
end

return M
