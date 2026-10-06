" Shared colour-scheme builder for aitdark / aitlight.
function! s:hi(group, fg, bg, attr) abort
  let l:cmd = 'highlight ' . a:group . ' guifg=' . (a:fg ==# '' ? 'NONE' : a:fg) . ' guibg=' . (a:bg ==# '' ? 'NONE' : a:bg)
  let l:cmd .= ' gui=' . (a:attr ==# '' ? 'NONE' : a:attr) . ' cterm=' . (a:attr ==# '' ? 'NONE' : a:attr)
  execute l:cmd
endfunction

function! ait#colors#apply(name, bg, p) abort
  highlight clear
  if exists('syntax_on') | syntax reset | endif
  let g:colors_name = a:name
  let &background = a:bg
  let l:p = a:p
  let l:H = function('s:hi')
  " --- UI ---
  call l:H('Normal', l:p.fg, l:p.bg, '')
  call l:H('NonText', l:p.faint, '', '')
  call l:H('EndOfBuffer', l:p.bg, '', '')
  call l:H('Whitespace', l:p.guide, '', '')
  call l:H('SpecialKey', l:p.guide, '', '')
  call l:H('LineNr', l:p.faint, '', '')
  call l:H('LineNrAbove', l:p.faint, '', '')
  call l:H('LineNrBelow', l:p.faint, '', '')
  call l:H('CursorLineNr', l:p.accent, l:p.line, 'bold')
  call l:H('CursorLine', '', l:p.line, '')
  call l:H('CursorColumn', '', l:p.line, '')
  call l:H('SignColumn', '', l:p.bg, '')
  call l:H('FoldColumn', l:p.faint, l:p.bg, '')
  call l:H('Folded', l:p.dim, l:p.line, 'italic')
  call l:H('ColorColumn', '', l:p.line, '')
  call l:H('Visual', '', l:p.sel, '')
  call l:H('VisualNOS', '', l:p.sel, '')
  call l:H('Search', l:p.bg, l:p.warn, '')
  call l:H('CurSearch', l:p.bg, l:p.accent, 'bold')
  call l:H('IncSearch', l:p.bg, l:p.accent, 'bold')
  call l:H('MatchParen', l:p.accent, l:p.sel, 'bold')
  call l:H('Pmenu', l:p.fg, l:p.pop, '')
  call l:H('PmenuSel', l:p.fg, l:p.sel, 'bold')
  call l:H('PmenuSbar', '', l:p.line, '')
  call l:H('PmenuThumb', '', l:p.faint, '')
  call l:H('PmenuKind', l:p.type, l:p.pop, '')
  call l:H('PmenuExtra', l:p.dim, l:p.pop, '')
  call l:H('StatusLine', l:p.fg, l:p.bar, '')
  call l:H('StatusLineNC', l:p.dim, l:p.line, '')
  call l:H('StatusLineTerm', l:p.fg, l:p.bar, '')
  call l:H('StatusLineTermNC', l:p.dim, l:p.line, '')
  call l:H('VertSplit', l:p.line2, l:p.bg, '')
  call l:H('TabLine', l:p.dim, l:p.bar, '')
  call l:H('TabLineFill', '', l:p.bar, '')
  call l:H('TabLineSel', l:p.fg, l:p.bg, 'bold')
  call l:H('WildMenu', l:p.bg, l:p.accent, 'bold')
  call l:H('Title', l:p.accent, '', 'bold')
  call l:H('Directory', l:p.func, '', '')
  call l:H('ErrorMsg', l:p.err, '', 'bold')
  call l:H('WarningMsg', l:p.warn, '', '')
  call l:H('MoreMsg', l:p.ok, '', '')
  call l:H('ModeMsg', l:p.accent, '', 'bold')
  call l:H('Question', l:p.ok, '', '')
  call l:H('QuickFixLine', '', l:p.sel, 'bold')
  call l:H('Conceal', l:p.faint, '', '')
  call l:H('SpellBad', l:p.err, '', 'undercurl')
  call l:H('SpellCap', l:p.warn, '', 'undercurl')
  call l:H('DiffAdd', '', l:p.addbg, '')
  call l:H('DiffChange', '', l:p.chgbg, '')
  call l:H('DiffDelete', l:p.err, l:p.delbg, '')
  call l:H('DiffText', '', l:p.sel, 'bold')
  " --- syntax ---
  call l:H('Comment', l:p.comment, '', 'italic')
  call l:H('Constant', l:p.const, '', '')
  call l:H('String', l:p.str, '', '')
  call l:H('Character', l:p.str, '', '')
  call l:H('Number', l:p.num, '', '')
  call l:H('Boolean', l:p.num, '', 'bold')
  call l:H('Float', l:p.num, '', '')
  call l:H('Identifier', l:p.fg, '', '')
  call l:H('Function', l:p.func, '', '')
  call l:H('Statement', l:p.kw, '', '')
  call l:H('Conditional', l:p.kw, '', '')
  call l:H('Repeat', l:p.kw, '', '')
  call l:H('Label', l:p.kw, '', '')
  call l:H('Operator', l:p.op, '', '')
  call l:H('Keyword', l:p.kw, '', '')
  call l:H('Exception', l:p.kw, '', '')
  call l:H('PreProc', l:p.pre, '', '')
  call l:H('Include', l:p.pre, '', '')
  call l:H('Define', l:p.pre, '', '')
  call l:H('Macro', l:p.pre, '', '')
  call l:H('PreCondit', l:p.pre, '', '')
  call l:H('Type', l:p.type, '', '')
  call l:H('StorageClass', l:p.kw, '', '')
  call l:H('Structure', l:p.type, '', '')
  call l:H('Typedef', l:p.type, '', '')
  call l:H('Special', l:p.special, '', '')
  call l:H('SpecialChar', l:p.special, '', '')
  call l:H('Delimiter', l:p.dim, '', '')
  call l:H('SpecialComment', l:p.special, '', 'italic')
  call l:H('Underlined', l:p.func, '', 'underline')
  call l:H('Error', l:p.err, '', 'bold')
  call l:H('Todo', l:p.bg, l:p.warn, 'bold')
  " --- MacAIterm extras ---
  call l:H('AitTodo', l:p.bg, l:p.warn, 'bold')
  call l:H('AitIllum', '', l:p.sel, '')
  call l:H('AitBorder', l:p.accent, l:p.pop, '')
  call l:H('AitGitAdd', l:p.ok, '', '')
  call l:H('AitGitChange', l:p.info, '', '')
  call l:H('AitGitDel', l:p.err, '', '')
  call l:H('AitSignErr', l:p.err, '', 'bold')
  call l:H('AitSignWarn', l:p.warn, '', 'bold')
  call l:H('AitSlNor', l:p.bg, l:p.info, 'bold')
  call l:H('AitSlIns', l:p.bg, l:p.ok, 'bold')
  call l:H('AitSlVis', l:p.bg, l:p.accent, 'bold')
  call l:H('AitSlRep', l:p.bg, l:p.err, 'bold')
  call l:H('AitSlCmd', l:p.bg, l:p.warn, 'bold')
  call l:H('AitSlGit', l:p.accent, l:p.bar, '')
  call l:H('AitSlMod', l:p.warn, l:p.bar, 'bold')
  call l:H('AitSlErr', l:p.bg, l:p.err, 'bold')
  call l:H('AitSlWarn', l:p.bg, l:p.warn, 'bold')
  " language-specific refinements (link to the groups above)
  highlight link pythonDecorator PreProc
  highlight link pythonBuiltin Type
  highlight link rustMacro PreProc
  highlight link rustLifetime Special
  highlight link rustModPath Type
  highlight link cppStructure Keyword
  highlight link shShellVariables Identifier
  highlight link shDerefSimple Special
  highlight link shQuote String
  highlight link shFunctionKey Keyword
endfunction
