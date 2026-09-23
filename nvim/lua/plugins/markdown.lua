-- Markdown. This is what you actually spend your time in.
--
-- No rendering layer. Markdown is shown as raw text: every #, **, and | is
-- visible, nothing is concealed, nothing is redrawn. Treesitter still colours
-- the file (see vim_config.lua), but it does not hide anything.
return {
  -- Pressing Enter on a bullet or a numbered item starts the next one, and
  -- numbered lists renumber themselves. <leader>x ticks a checkbox on or off.
  {
    'bullets-vim/bullets.vim',
    ft = { 'markdown', 'text' },
    init = function()
      vim.g.bullets_enabled_file_types = { 'markdown', 'text' }
      vim.g.bullets_set_mappings = 1
      vim.g.bullets_checkbox_markers = ' x'
      vim.g.bullets_outline_levels = { 'ROM', 'ABC', 'num', 'abc', 'rom', 'std-' }
    end,
  },

  -- Markdown-only settings, applied when a .md file opens.
  {
    'nvim-lua/plenary.nvim',
    lazy = true,
    init = function()
      vim.api.nvim_create_autocmd('FileType', {
        pattern = 'markdown',
        callback = function()
          vim.opt_local.wrap = true
          vim.opt_local.linebreak = true
          vim.opt_local.breakindent = true
          vim.opt_local.conceallevel = 0
          vim.opt_local.concealcursor = ''
          vim.opt_local.spell = false
        end,
      })
    end,
  },
}
