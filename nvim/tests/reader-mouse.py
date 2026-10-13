"""Run: uv run --with pynvim python nvim/tests/reader-mouse.py"""
import os
import pathlib
import signal
import subprocess
import tempfile

import pynvim

CONFIG = pathlib.Path(__file__).resolve().parents[1] / 'init.lua'


def timeout_handler(*_):
    raise TimeoutError('Reader mouse test exceeded 25 seconds')


signal.signal(signal.SIGALRM, timeout_handler)
signal.alarm(25)


def screen(client):
    return client.exec_lua('''
      vim.cmd.redraw()
      local out = {}
      for row = 1, vim.o.lines do
        local text = ''
        for col = 1, vim.o.columns do text = text .. vim.fn.screenstring(row, col) end
        out[row] = text
      end
      return out
    ''')


def click_label(client, label, bottom=False):
    rows = screen(client)
    bounds = None if bottom else client.exec_lua('''
      local panel = require('reader').panel
      if not panel or not panel.picker then return nil end
      local win = panel.picker.list.win.win
      local pos = vim.api.nvim_win_get_position(win)
      return { pos[1], pos[2], vim.api.nvim_win_get_height(win), vim.api.nvim_win_get_width(win) }
    ''')
    hits = []
    for row, text in enumerate(rows):
        if bounds:
            top, left, height, width = bounds
            if not top <= row < top + height:
                continue
            text = text[left:left + width]
        else:
            left = 0
        if label in text:
            hits.append((row, left + text.index(label)))
    assert hits, f'Control missing: {label}\n' + '\n'.join(rows)
    row, col = hits[-1] if bottom else hits[0]
    client.api.input_mouse('left', 'press', '', 0, row, col + 1)
    client.api.input_mouse('left', 'release', '', 0, row, col + 1)
    client.exec_lua('vim.wait(100, function() return false end, 10)')
    return row, col + 1


with tempfile.TemporaryDirectory(prefix='nvim-reader-mouse-') as fixture:
    root = pathlib.Path(fixture).resolve()
    repo = root / 'project'
    repo.mkdir()
    (repo / 'README.md').write_text('# Reader\n\n[Guide](guide.md)\n')
    (repo / 'guide.md').write_text('# Guide\n\nMain document\n')
    (repo / 'note.txt').write_text('Plain writing\n')
    (repo / 'script.lua').write_text('return true\n')

    def git(*args):
        subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, timeout=10)

    git('init', '-b', 'main')
    git('config', 'user.name', 'Reader Test')
    git('config', 'user.email', 'reader-test@example.invalid')
    git('add', '.')
    git('commit', '-m', 'main')
    git('switch', '-c', 'feature')
    (repo / 'guide.md').write_text('# Guide\n\nFeature document\n')
    git('commit', '-am', 'feature')
    git('switch', 'main')
    (root / 'config').mkdir()
    (root / 'config' / 'nvim').symlink_to(CONFIG.parent)
    client = None
    child_pid = None

    def launch(file=None):
        global child_pid
        args = ['env', f'XDG_STATE_HOME={root / "state"}', f'XDG_CONFIG_HOME={root / "config"}', 'nvim', '--embed', '-i', 'NONE', '-u', str(CONFIG)]
        if file:
            args.append(str(file))
        nvim = pynvim.attach('child', argv=args)
        child_pid = nvim.eval('getpid()')
        nvim.ui_attach(140, 35, rgb=False)
        nvim.exec_lua('assert(vim.wait(5000, function() return require("reader").working_branch == "main" end, 10))')
        return nvim

    try:
        client = launch(repo / 'README.md')
        rows = screen(client)
        assert all(label in '\n'.join(rows) for label in [
            'Sidebar', 'Search', 'Branches', 'Push', 'Edit',
            'File actions', 'Help', 'Close', 'Quit',
        ])
        assert not any(label in '\n'.join(rows) for label in ['Working files', 'Project files', 'All files'])
        assert 'Formatted' in rows[-2], 'Markdown must offer its current view'
        markdown_buf = client.exec_lua('return require("reader").file_buffer()')
        markdown_text = client.api.buf_get_lines(markdown_buf, 0, -1, False)
        view_position = click_label(client, 'Formatted', bottom=True)
        assert not client.exec_lua('return require("render-markdown").get()')
        client.exec_lua('assert(vim.wait(2000, function() return vim.wo[require("reader").file_window()].conceallevel == 0 end, 10))')
        assert '# Reader' in '\n'.join(screen(client)), 'Source must show Markdown syntax\n' + '\n'.join(screen(client))
        assert click_label(client, 'Source', bottom=True) == view_position, 'Markdown view control must stay in place'
        assert client.exec_lua('return require("render-markdown").get()')
        client.exec_lua('assert(vim.wait(2000, function() return vim.wo[require("reader").file_window()].conceallevel == 3 end, 10))')
        assert '# Reader' not in '\n'.join(screen(client)), 'Formatted must render Markdown syntax'
        assert client.api.buf_get_lines(markdown_buf, 0, -1, False) == markdown_text
        assert not client.api.buf_get_option(markdown_buf, 'modified')
        assert client.exec_lua('return vim.api.nvim_get_hl(0, {name="BufferLineCloseButtonSelected"}).ctermfg') == 1
        click_label(client, 'script.lua')
        source_buf = client.exec_lua('return require("reader").file_buffer()')
        assert 'Edit' not in screen(client)[-2], 'Source files must not offer Edit'
        assert 'Formatted' not in screen(client)[-2] and 'Source' not in screen(client)[-2], 'Code must not offer Markdown views'
        client.exec_lua('require("reader").edit_file()')
        assert not client.api.buf_get_option(source_buf, 'modifiable'), 'Edit command must refuse source files too'
        assert (repo / 'script.lua').read_text() == 'return true\n'
        client.ui_try_resize(80, 35)
        click_label(client, 'More', bottom=True)
        labels = client.exec_lua('local out = {}; for _, item in ipairs(require("reader").panel.picker:items()) do out[#out+1] = item.item[1] end; return out')
        assert 'Help' in labels and 'Edit' not in labels and 'Save' not in labels and 'Open folder' not in labels
        click_label(client, 'More', bottom=True)
        assert not client.exec_lua('return require("reader").panel ~= nil')
        client.ui_try_resize(140, 35)
        click_label(client, 'note.txt')
        text_buf = client.exec_lua('return require("reader").file_buffer()')
        edit_position = click_label(client, 'Edit', bottom=True)
        assert client.api.buf_get_option(text_buf, 'modifiable'), 'Text files must support editing'
        assert 'Formatted' not in screen(client)[-2] and 'Source' not in screen(client)[-2]
        assert click_label(client, 'Edit', bottom=True) == edit_position, 'Edit must not move when active'
        assert client.exec_lua('return require("reader").file_buffer()') == text_buf
        assert not client.api.buf_get_option(text_buf, 'modifiable'), 'Second Edit click must return to reading'
        click_label(client, 'Edit', bottom=True)
        click_label(client, 'Close', bottom=True)
        assert client.exec_lua('return require("reader").file_buffer()') == text_buf, 'Close must stop editing, not close the document'
        assert not client.api.buf_get_option(text_buf, 'modifiable')
        assert 'Open folder' not in '\n'.join(screen(client))
        tab_row = screen(client)[0]
        close_col = tab_row.index('×', tab_row.index('note.txt'))
        client.api.input_mouse('left', 'press', '', 0, 0, close_col)
        client.api.input_mouse('left', 'release', '', 0, 0, close_col)
        client.exec_lua('vim.wait(100, function() return false end, 10)')
        assert not client.api.buf_get_option(text_buf, 'buflisted'), 'A tab × must explicitly close its document'
        client.exec_lua('require("reader").open_file(...)', str(repo / 'guide.md'))
        assert client.exec_lua('return vim.fs.basename(vim.api.nvim_buf_get_name(require("reader").file_buffer()))') == 'guide.md'
        branch_position = click_label(client, 'Branches', bottom=True)
        assert client.exec_lua('return require("reader").panel.picker.opts.title') == 'Branches — click to read committed files'
        assert click_label(client, 'Branches', bottom=True) == branch_position, 'Branches must not move while its menu is open'
        assert not client.exec_lua('return require("reader").panel ~= nil'), 'A second Branches click must dismiss the menu'
        click_label(client, 'Branches', bottom=True)
        more_position = click_label(client, 'More', bottom=True)
        assert client.exec_lua('return require("reader").panel and require("reader").panel.picker.opts.title') == 'More', 'More disappeared instead of opening'
        assert click_label(client, 'More', bottom=True) == more_position, 'More must not move while its menu is open'
        assert not client.exec_lua('return require("reader").panel ~= nil'), 'A second More click must dismiss the menu'
        click_label(client, 'Branches', bottom=True)
        click_label(client, 'feature')
        client.exec_lua('assert(vim.wait(5000, function() return require("reader").view ~= nil end, 10))')
        assert 'Reading branch: feature' in '\n'.join(screen(client))
        assert client.exec_lua('return vim.api.nvim_buf_get_lines(require("reader").file_buffer(), 2, 3, false)[1]') == 'Feature document'
        click_label(client, 'Back', bottom=True)
        assert client.exec_lua('return vim.api.nvim_buf_get_lines(require("reader").file_buffer(), 2, 3, false)[1]') == 'Main document'
        click_label(client, 'Help', bottom=True)
        assert client.exec_lua('return vim.fs.basename(vim.api.nvim_buf_get_name(require("reader").file_buffer()))') == 'CHEATSHEET.md'
        client.exec_lua('require("reader").open_file(...)', str(repo / 'guide.md'))
        search_position = click_label(client, 'Search', bottom=True)
        assert click_label(client, 'Search', bottom=True) == search_position
        assert not client.exec_lua('return require("reader").panel ~= nil'), 'Second Search click must dismiss the menu'
        click_label(client, 'Search', bottom=True)
        assert 'File contents' in '\n'.join(screen(client))
        click_label(client, 'README.md')
        assert not client.exec_lua('return require("reader").panel ~= nil')
        click_label(client, 'Search', bottom=True)
        click_label(client, 'Close', bottom=True)
        assert not client.exec_lua('return require("reader").panel ~= nil')
        assert client.exec_lua('return require("render-markdown").get()')
        click_label(client, 'Edit', bottom=True)
        assert client.exec_lua('return vim.bo[require("reader").file_buffer()].modifiable')
        edited_buf = client.exec_lua('return require("reader").file_buffer()')
        original_text = (repo / 'README.md').read_text()
        client.input('unsaved writing')
        client.exec_lua('vim.wait(100, function() return false end, 10)')
        assert client.api.buf_get_option(edited_buf, 'modified'), 'Typing must change the document'
        click_label(client, 'Close', bottom=True)
        assert 'Unsaved changes' in '\n'.join(screen(client)), 'Close must offer a choice for unsaved edits\n' + '\n'.join(screen(client))
        assert client.eval('mode(1)') == 'n', 'Close left the confirmation in insert mode'
        click_label(client, 'Cancel')
        assert client.api.buf_get_option(edited_buf, 'modified'), 'Cancel must preserve unsaved writing'
        assert client.exec_lua('return require("reader").file_buffer()') == edited_buf
        assert client.eval('mode(1)').startswith('i'), 'Cancel must let me continue typing'
        dirty_text = client.api.buf_get_lines(edited_buf, 0, -1, False)
        click_label(client, 'Formatted', bottom=True)
        click_label(client, 'Source', bottom=True)
        assert client.api.buf_get_lines(edited_buf, 0, -1, False) == dirty_text, 'Markdown view changes must preserve unsaved writing'
        assert client.api.buf_get_option(edited_buf, 'modified') and client.api.buf_get_option(edited_buf, 'modifiable')
        assert client.eval('mode(1)').startswith('i'), 'Changing presentation must allow continued typing'
        click_label(client, 'Close', bottom=True)
        click_label(client, 'Discard changes')
        assert (repo / 'README.md').read_text() == original_text, 'Discard must not save writing'
        assert client.api.buf_get_option(edited_buf, 'buflisted'), 'Ending Edit must keep the document tab'
        assert client.exec_lua('return require("reader").file_buffer()') == edited_buf
        assert client.exec_lua('return table.concat(vim.api.nvim_buf_get_lines(..., 0, -1, false), "\\n") .. "\\n"', edited_buf) == original_text
        assert not client.api.buf_get_option(edited_buf, 'modifiable') and not client.api.buf_get_option(edited_buf, 'modified')
        assert client.eval('mode(1)') == 'n', 'Discard left the editor in insert mode'
        click_label(client, 'Search', bottom=True)
        click_label(client, 'README.md')
        click_label(client, 'Edit', bottom=True)
        click_label(client, 'Close', bottom=True)
        assert client.eval('mode(1)') == 'n', 'Closing unchanged edit mode left the editor stuck'
        assert client.exec_lua('return require("reader").file_buffer()') == edited_buf
        assert not client.api.buf_get_option(edited_buf, 'modifiable')
        click_label(client, 'Close', bottom=True)
        assert client.api.buf_get_option(edited_buf, 'buflisted'), 'Close must never remove the document'
        assert client.exec_lua('return require("reader").file_buffer()') == edited_buf
        click_label(client, 'Search', bottom=True)
        click_label(client, 'README.md')
        client.exec_lua('vim.api.nvim_win_set_cursor(require("reader").file_window(), {1, 0})')
        click_label(client, 'Edit', bottom=True)
        client.input('saved writing')
        client.exec_lua('vim.wait(100, function() return false end, 10)')
        click_label(client, 'Close', bottom=True)
        click_label(client, 'Save changes')
        assert (repo / 'README.md').read_text() == 'saved writing' + original_text, 'Save changes must write the edits'
        assert client.eval('mode(1)') == 'n', 'Save changes left the editor in insert mode'
        assert client.exec_lua('return vim.fs.basename(vim.api.nvim_buf_get_name(require("reader").file_buffer()))') == 'README.md'
        assert not client.exec_lua('return vim.bo[require("reader").file_buffer()].modifiable')
        click_label(client, 'Search', bottom=True)
        click_label(client, 'README.md')
        click_label(client, 'Edit', bottom=True)
        click_label(client, 'Save', bottom=True)
        assert not client.exec_lua('return vim.bo[require("reader").file_buffer()].modifiable')
        file_actions_position = click_label(client, 'File actions', bottom=True)
        assert click_label(client, 'File actions', bottom=True) == file_actions_position, 'File actions must stay visible and in place'
        assert not client.exec_lua('return require("reader").panel ~= nil'), 'Second File actions click must dismiss the menu'
        client.exec_lua('vim.api.nvim_win_set_cursor(require("reader").file_window(), {1, 0})')
        click_label(client, 'Edit', bottom=True)
        client.input('tab writing')
        client.exec_lua('vim.wait(100, function() return false end, 10)')
        tab_col = screen(client)[0].index('README.md') + 1
        client.api.input_mouse('right', 'press', '', 0, 0, tab_col)
        client.api.input_mouse('right', 'release', '', 0, 0, tab_col)
        client.exec_lua('vim.wait(100, function() return false end, 10)')
        click_label(client, 'Cancel')
        assert client.api.buf_get_option(edited_buf, 'modified') and client.api.buf_get_option(edited_buf, 'buflisted')
        client.api.input_mouse('right', 'press', '', 0, 0, tab_col)
        client.api.input_mouse('right', 'release', '', 0, 0, tab_col)
        client.exec_lua('vim.wait(100, function() return false end, 10)')
        click_label(client, 'Save and close')
        assert (repo / 'README.md').read_text() == 'tab writing' + 'saved writing' + original_text
        assert not client.api.buf_get_option(edited_buf, 'buflisted'), 'Explicit tab closure must close the dirty document'
        click_label(client, 'Search', bottom=True)
        click_label(client, 'README.md')
        click_label(client, 'File actions', bottom=True)
        click_label(client, 'New file')
        client.input('created.md')
        click_label(client, 'Submit', bottom=True)
        assert (repo / 'created.md').exists()
        click_label(client, 'created.md', bottom=True)
        click_label(client, 'File actions', bottom=True)
        click_label(client, 'Delete')
        click_label(client, 'Close', bottom=True)
        assert (repo / 'created.md').exists(), 'Dismissed deletion must leave the file intact'
        click_label(client, 'File actions', bottom=True)
        click_label(client, 'Delete')
        click_label(client, 'Confirm')
        assert not (repo / 'created.md').exists()
        client.exec_lua('vim.ui.input({prompt="Cancel me"}, function(value) vim.g.reader_test_cancel=value or "cancelled" end)')
        click_label(client, 'Close', bottom=True)
        assert client.exec_lua('return vim.g.reader_test_cancel') == 'cancelled'
        client.ui_try_resize(80, 35)
        client.exec_lua('vim.wait(100, function() return false end, 10)')
        assert all(label in '\n'.join(screen(client)) for label in ['Sidebar', 'Search', 'Branches', 'More', 'Close', 'Quit'])
        click_label(client, 'More', bottom=True)
        more = '\n'.join(screen(client))
        assert 'File actions' in more and 'Help' in more
        assert 'Show source' in more
        assert not any(label in more for label in ['Show everything', 'Show project files'])
        click_label(client, 'Show source')
        assert not client.exec_lua('return require("render-markdown").get()')
        assert 'Source' in screen(client)[-2]
        click_label(client, 'Source', bottom=True)
        click_label(client, 'More', bottom=True)
        click_label(client, 'Help')
        assert client.exec_lua('return vim.fs.basename(vim.api.nvim_buf_get_name(require("reader").file_buffer()))') == 'CHEATSHEET.md'
        help_text = client.exec_lua('return table.concat(vim.api.nvim_buf_get_lines(require("reader").file_buffer(), 0, -1, false), "\\n")')
        assert not any(w in help_text for w in ['Working files', 'Project files', 'All files'])
        assert len(help_text.splitlines()) < 45
        client.exec_lua('require("reader").open_file(...)', str(repo / 'guide.md'))
        try:
            client.command('qall')
        except EOFError:
            pass
        child_pid = None
        client.close()
        os.chdir(repo)
        client = launch()
        assert client.exec_lua('return vim.fs.basename(vim.api.nvim_buf_get_name(require("reader").file_buffer()))') == 'guide.md'
        assert not client.exec_lua('return vim.bo[require("reader").file_buffer()].modifiable')
        client.ui_try_resize(80, 35)
        click_label(client, 'Formatted', bottom=True)
        assert 'Source' in screen(client)[-2], 'Markdown view must remain visible on a narrow screen'
        try:
            client.command('qall')
        except EOFError:
            pass
        child_pid = None
        client.close()
        client = launch(repo)
        assert client.exec_lua('return vim.fs.basename(vim.api.nvim_buf_get_name(require("reader").file_buffer()))') == 'guide.md'
        assert 'Source' in screen(client)[-2], 'Markdown view must survive restart'
        assert not client.exec_lua('return require("render-markdown").get()')
        click_label(client, 'Edit', bottom=True)
        client.input('orphaned writing')
        client.exec_lua('vim.wait(100, function() return false end, 10)')
        orphaned_buf = client.exec_lua('return require("reader").file_buffer()')
        assert client.api.buf_get_option(orphaned_buf, 'modified')
        moved_repo = root / 'moved-project'
        repo.rename(moved_repo)
        click_label(client, 'Branches', bottom=True)
        notice = client.exec_lua('local message; for _, note in ipairs(Snacks.notifier.get_history()) do if note.msg:match("^Git:") then message = note.msg end end; return message')
        assert notice == 'Git: This folder no longer exists. Reopen Neovim in an existing folder.', notice
        assert not client.exec_lua('return require("reader").panel ~= nil'), 'Missing folder must not leave a broken picker'
        assert client.api.buf_get_option(orphaned_buf, 'modified'), 'Missing folder must preserve writing'
        client.api.buf_set_option(orphaned_buf, 'modified', False)
        print('Reader mouse file policy, editing actions, menu toggles, branch browsing, narrow layout, and restoration: passed')
        try:
            client.command('qall')
        except EOFError:
            pass
        child_pid = None
    finally:
        signal.alarm(0)
        if child_pid:
            try:
                os.kill(child_pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        if client:
            client.close()
