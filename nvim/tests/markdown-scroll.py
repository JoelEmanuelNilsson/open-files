"""Run: uv run --with pynvim python nvim/tests/markdown-scroll.py

Formatted Markdown must look the same however the window reached a position:
wheel-scrolling through a document must leave exactly what a full redraw and a
fresh render would show at the same view."""
import pathlib
import signal
import tempfile

import pynvim

CONFIG = pathlib.Path(__file__).resolve().parents[1] / 'init.lua'
SCREEN = '''vim.cmd.redraw()
local out = {}
for row = 1, vim.o.lines do
  local text = ''
  for col = 1, vim.o.columns do text = text .. vim.fn.screenstring(row, col) end
  out[row] = text
end
return out'''


def timeout_handler(*_):
    raise TimeoutError('Markdown scroll test exceeded 180 seconds')


def document(wide_tables):
    lines = []
    for section in range(12):
        lines += [f'## Section {section}', '']
        for paragraph in range(3):
            lines += [f'Paragraph {section}.{paragraph} mentions `lib/file{paragraph}.sh` and **bold** words,',
                      'then wraps onto a second hard-wrapped line of prose about the',
                      'reader, ending on a third.', '']
        lines += ['```' if section % 2 else '```sh', f'echo section {section}', 'exit 0', '```', '']
        lines += ['| File | Purpose |', '| --- | --- |']
        lines += [f'| `lib/long-name-{row}.sh` | row {row} of section {section} |' for row in range(10)]
        lines += ['']
        if not wide_tables:
            continue
        lines += ['| What | How it arrives | Cost at rest |', '|---|---|---|']
        lines += [f'| a long description of source {row} in section {section} | `a long command that delivers {row}` | nothing at all, ever |' for row in range(6)]
        lines += ['Prose follows the wide table directly, so its cells wrap into virtual lines.', '']
    # Re-rendering at the end of the buffer moves the view, so tables stay clear of it.
    lines += [f'Closing line {line}.' for line in range(100)]
    return '\n'.join(lines) + '\n'


def difference(left, right):
    return '\n'.join(f'{row:2} |{a.rstrip()}\n   |{b.rstrip()}' for row, (a, b) in enumerate(zip(left, right)) if a != b)


def scroll(client, win, direction, steps):
    top, left = client.exec_lua('return vim.api.nvim_win_get_position(...)', win)
    for step in range(steps):
        client.api.input_mouse('wheel', direction, '', 0, top + 5, left + 10)
        client.exec_lua('vim.wait(30, function() return false end, 5)')
        shown = client.exec_lua(SCREEN)
        redrawn = client.exec_lua('vim.cmd("redraw!")\n' + SCREEN)
        assert shown == redrawn, f'Scrolling {direction} left stale rows at step {step}\n' + difference(shown, redrawn)
        client.exec_lua('''
          local win = ...
          local view = vim.api.nvim_win_call(win, vim.fn.winsaveview)
          require('render-markdown.core.ui').update(vim.api.nvim_win_get_buf(win), win, 'test', true)
          vim.wait(50, function() return false end, 5)
          vim.api.nvim_win_call(win, function() vim.fn.winrestview(view) end)
        ''', win)
        rendered = client.exec_lua('vim.cmd("redraw!")\n' + SCREEN)
        assert shown == rendered, f'Scrolling {direction} showed a render from another view at step {step}\n' + difference(shown, rendered)


def check(root, wide_tables):
    path = root / 'project' / f'doc-{"wide" if wide_tables else "narrow"}.md'
    path.write_text(document(wide_tables))
    client = pynvim.attach('child', argv=[
        'env', f'XDG_STATE_HOME={root / "state"}', f'XDG_CONFIG_HOME={root / "config"}',
        'nvim', '--embed', '-i', 'NONE', '-u', str(CONFIG), str(path),
    ])
    try:
        client.ui_attach(120, 40, rgb=False)
        client.exec_lua('assert(vim.wait(5000, function() return require("render-markdown").get() and vim.wo[require("reader").file_window()].conceallevel == 3 end, 10))')
        win = client.exec_lua('return require("reader").file_window()')
        scroll(client, win, 'down', 140)
        scroll(client, win, 'up', 140)
    finally:
        client.close()


signal.signal(signal.SIGALRM, timeout_handler)
signal.alarm(180)
with tempfile.TemporaryDirectory(prefix='nvim-markdown-scroll-') as fixture:
    root = pathlib.Path(fixture).resolve()
    (root / 'project').mkdir()
    (root / 'config').mkdir()
    (root / 'config' / 'nvim').symlink_to(CONFIG.parent)
    # Narrow tables catch renders from another view; wide ones wrap into conceal_lines marks.
    check(root, wide_tables=False)
    check(root, wide_tables=True)
print('markdown scroll: ok')
