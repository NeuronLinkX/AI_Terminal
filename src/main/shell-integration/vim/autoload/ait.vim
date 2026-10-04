" ---------- statusline / tabline ----------
let s:mode_names = {'n': 'NORMAL', 'no': 'OP', 'v': 'VISUAL', 'V': 'V-LINE', "\<C-v>": 'V-BLOCK', 's': 'SELECT', 'i': 'INSERT', 'R': 'REPLACE', 'c': 'COMMAND', 't': 'TERMINAL', '!': 'SHELL'}
function! s:mode_group(m) abort
  let l:c = a:m[0]
  if l:c ==# 'i' | return 'AitSlIns' | endif
  if l:c ==# 'R' | return 'AitSlRep' | endif
  if l:c =~# '[vVsS]' || a:m[0] ==# "\<C-v>" | return 'AitSlVis' | endif
  if l:c ==# 'c' || l:c ==# 't' | return 'AitSlCmd' | endif
  return 'AitSlNor'
endfunction

function! ait#statusline() abort
  let l:active = get(g:, 'statusline_winid', win_getid()) == win_getid()
  if !l:active
    return '%#StatusLineNC# %f %m%r%=%y %l:%c '
  endif
  let l:m = mode()
  let l:name = get(s:mode_names, l:m, get(s:mode_names, l:m[0], l:m))
  let l:s = '%#' . s:mode_group(l:m) . '# ' . l:name . ' %#AitSlGit#'
  let l:br = get(b:, 'ait_branch', '')
  if l:br !=# ''
    let l:s .= '  ' . substitute(l:br, '%', '%%', 'g') . ' '
  endif
  let l:s .= '%#StatusLine# %f %#AitSlMod#%m%r%h%w%#StatusLine#'
  let l:s .= '%=%#StatusLine#'
  if get(g:, 'ait_ai_busy', 0) | let l:s .= '%#AitSlGit# ✦ AI… ' | endif
  let l:lsp = ait#lsp#status()
  if l:lsp !=# '' | let l:s .= '%#AitSlGit# ' . l:lsp . ' ' | endif
  let l:q = get(b:, 'ait_diag', [0, 0])
  if l:q[0] > 0 | let l:s .= '%#AitSlErr# ✖ ' . l:q[0] . ' ' | endif
  if l:q[1] > 0 | let l:s .= '%#AitSlWarn# ▲ ' . l:q[1] . ' ' | endif
  let l:g = get(b:, 'ait_gitstat', '')
  if l:g !=# '' | let l:s .= '%#AitSlGit# ' . l:g . ' ' | endif
  let l:s .= '%#StatusLine# ' . (&filetype ==# '' ? 'plain' : &filetype) . '  ' . (&fileencoding ==# '' ? &encoding : &fileencoding) . ' '
  let l:s .= '%#' . s:mode_group(l:m) . '# %l:%c  %P '
  return l:s
endfunction

function! ait#tabline() abort
  let l:s = ''
  for l:i in range(1, tabpagenr('$'))
    let l:b = tabpagebuflist(l:i)[tabpagewinnr(l:i) - 1]
    let l:n = fnamemodify(bufname(l:b), ':t')
    let l:s .= (l:i == tabpagenr() ? '%#TabLineSel#' : '%#TabLine#') . ' ' . l:i . ' ' . (l:n ==# '' ? '[No Name]' : l:n) . ' '
  endfor
  return l:s . '%#TabLineFill#'
endfunction

" ---------- indent guides ----------
function! ait#guides() abort
  if &buftype !=# '' | return | endif
  let l:sw = shiftwidth()
  if &expandtab
    execute 'setlocal listchars=tab:▸\ ,trail:·,nbsp:␣,extends:›,precedes:‹,leadmultispace:│' . repeat('\ ', max([l:sw - 1, 1]))
  else
    setlocal listchars=tab:│\ ,trail:·,nbsp:␣,extends:›,precedes:‹
  endif
endfunction

" ---------- auto pairs ----------
function! ait#open(o, c) abort
  if getline('.')[col('.') - 1] =~# '\w' | return a:o | endif
  return a:o . a:c . "\<Left>"
endfunction
function! ait#close(c) abort
  return getline('.')[col('.') - 1] ==# a:c ? "\<Right>" : a:c
endfunction
function! ait#quote(q) abort
  let l:line = getline('.') | let l:col = col('.')
  let l:next = l:line[l:col - 1] | let l:prev = l:col > 1 ? l:line[l:col - 2] : ''
  if l:next ==# a:q | return "\<Right>" | endif
  if l:prev =~# '\w' || l:next =~# '\w' | return a:q | endif
  if a:q ==# "'" && &filetype ==# 'rust' | return a:q | endif
  if a:q ==# "'" && &filetype ==# 'sh' && l:prev =~# '[$\\]' | return a:q | endif
  return a:q . a:q . "\<Left>"
endfunction
function! ait#bs() abort
  let l:line = getline('.') | let l:col = col('.')
  if l:col > 1 && index(['()', '[]', '{}', '""', "''"], l:line[l:col - 2] . l:line[l:col - 1]) >= 0
    return "\<BS>\<Del>"
  endif
  return "\<BS>"
endfunction
function! ait#cr() abort
  let l:line = getline('.') | let l:col = col('.')
  if l:col > 1 && l:line[l:col - 2] ==# '{' && l:line[l:col - 1] ==# '}'
    return "\<CR>\<Esc>O"
  endif
  return "\<CR>"
endfunction
function! ait#tab() abort
  if pumvisible() | return "\<C-n>" | endif
  if strpart(getline('.'), 0, col('.') - 1) =~# '\k$'
    return &omnifunc !=# '' ? "\<C-x>\<C-o>" : "\<C-n>"
  endif
  return "\<Tab>"
endfunction

" ---------- word under cursor highlight ----------
function! ait#illum_clear() abort
  if exists('w:ait_illum')
    silent! call matchdelete(w:ait_illum)
    unlet w:ait_illum
  endif
endfunction
function! ait#illum() abort
  call ait#illum_clear()
  if mode() !=# 'n' || &buftype !=# '' | return | endif
  let l:w = expand('<cword>')
  if l:w =~# '^\k\{3,}$' && l:w !~# '^\d'
    let w:ait_illum = matchadd('AitIllum', '\V\<' . escape(l:w, '\') . '\>', -1)
  endif
endfunction
function! ait#todo() abort
  if &buftype !=# '' | return | endif
  silent! syntax match AitTodo /\v<(TODO|FIXME|XXX|HACK|BUG|NOTE)>/ containedin=.*Comment.*,.*String.* contained
endfunction

" ---------- git: branch + gutter signs ----------
let s:signs_ready = 0
function! s:sign_init() abort
  if s:signs_ready | return | endif
  let s:signs_ready = 1
  call sign_define('AitGitAdd',    {'text': '▎', 'texthl': 'AitGitAdd'})
  call sign_define('AitGitChange', {'text': '▎', 'texthl': 'AitGitChange'})
  call sign_define('AitGitDel',    {'text': '▁', 'texthl': 'AitGitDel'})
  call sign_define('AitErr',  {'text': '●', 'texthl': 'AitSignErr'})
  call sign_define('AitWarn', {'text': '●', 'texthl': 'AitSignWarn'})
endfunction

function! ait#gitrefresh() abort
  if &buftype !=# '' || expand('%') ==# '' | return | endif
  call s:sign_init()
  call sign_unplace('ait_git', {'buffer': bufnr('%')})
  let b:ait_branch = '' | let b:ait_gitstat = ''
  let l:f = expand('%:p')
  if !filereadable(l:f) || !executable('git') | return | endif
  let l:d = shellescape(fnamemodify(l:f, ':h'))
  let l:br = systemlist('git -C ' . l:d . ' symbolic-ref --short -q HEAD 2>/dev/null')
  if v:shell_error || empty(l:br) | return | endif
  let b:ait_branch = l:br[0]
  let l:out = systemlist('git -C ' . l:d . ' diff --no-color -U0 -- ' . shellescape(l:f) . ' 2>/dev/null')
  if v:shell_error | return | endif
  let [l:a, l:c, l:r] = [0, 0, 0]
  for l:ln in l:out
    let l:m = matchlist(l:ln, '^@@ -\d\+\(,\(\d\+\)\)\= +\(\d\+\)\(,\(\d\+\)\)\= @@')
    if empty(l:m) | continue | endif
    let l:old = l:m[2] ==# '' ? 1 : str2nr(l:m[2])
    let l:start = str2nr(l:m[3])
    let l:new = l:m[5] ==# '' ? 1 : str2nr(l:m[5])
    if l:new == 0
      call sign_place(0, 'ait_git', 'AitGitDel', bufnr('%'), {'lnum': max([l:start, 1]), 'priority': 8})
      let l:r += l:old
    else
      let l:name = l:old == 0 ? 'AitGitAdd' : 'AitGitChange'
      for l:n in range(l:start, l:start + l:new - 1)
        call sign_place(0, 'ait_git', l:name, bufnr('%'), {'lnum': l:n, 'priority': 8})
      endfor
      if l:old == 0 | let l:a += l:new | else | let l:c += l:new | endif
    endif
  endfor
  let b:ait_gitstat = join(filter([l:a ? '+' . l:a : '', l:c ? '~' . l:c : '', l:r ? '-' . l:r : ''], 'v:val !=# ""'), ' ')
endfunction

" ---------- diagnostics via :make (F6) ----------
function! s:project_root(markers) abort
  for l:m in a:markers
    let l:f = findfile(l:m, expand('%:p:h') . ';')
    if l:f !=# '' | return fnamemodify(l:f, ':p:h') | endif
  endfor
  return ''
endfunction

function! ait#check() abort
  silent! update
  let l:ft = &filetype
  let l:prog = '' | let l:efm = '' | let l:cd = ''
  if l:ft ==# 'python'
    if executable('ruff')
      let l:prog = 'ruff check --output-format=concise ' . expand('%:p:S') | let l:efm = '%f:%l:%c: %m'
    else
      let l:prog = 'python3 -m py_compile ' . expand('%:p:S') | let l:efm = '%A  File "%f"\, line %l,%C    %.%#,%Z%[%^ ]%\@=%m'
    endif
  elseif l:ft ==# 'c'
    let l:prog = 'cc -fsyntax-only -Wall -Wextra ' . expand('%:p:S')
  elseif l:ft ==# 'cpp'
    let l:prog = 'c++ -std=c++17 -fsyntax-only -Wall -Wextra ' . expand('%:p:S')
  elseif l:ft ==# 'rust'
    let l:root = s:project_root(['Cargo.toml'])
    if l:root !=# ''
      let l:prog = 'cargo check --quiet --message-format=short' | let l:cd = l:root
    else
      let l:prog = 'rustc --edition 2021 --emit=metadata --out-dir ' . shellescape(fnamemodify(tempname(), ':h')) . ' --error-format=short ' . expand('%:p:S')
    endif
    let l:efm = '%f:%l:%c: %trror%m,%f:%l:%c: %tarning%m'
  elseif l:ft ==# 'sh' || l:ft ==# 'bash' || l:ft ==# 'zsh'
    let l:prog = executable('shellcheck') ? 'shellcheck -f gcc ' . expand('%:p:S') : 'bash -n ' . expand('%:p:S')
    let l:efm = executable('shellcheck') ? '' : '%f: line %l: %m'
  else
    echo 'AI Terminal: 이 파일 형식(' . l:ft . ')의 검사기가 없습니다'
    return
  endif
  let l:old_prg = &l:makeprg | let l:old_efm = &l:errorformat
  let &l:makeprg = l:prog
  if l:efm !=# '' | let &l:errorformat = l:efm | endif
  if l:cd !=# '' | execute 'lcd ' . fnameescape(l:cd) | endif
  silent! make!
  if l:cd !=# '' | lcd - | endif
  let &l:makeprg = l:old_prg | let &l:errorformat = l:old_efm
  redraw!
  call s:diag_signs()
  let l:items = filter(getqflist(), 'v:val.valid')
  if empty(l:items)
    cclose
    echo '✔ 문제 없음 (' . l:ft . ')'
  else
    botright copen 8
    wincmd p
    echo '✖ ' . len(l:items) . '개 문제 — ]d / [d 로 이동, :cclose 로 닫기'
  endif
endfunction

function! s:diag_signs() abort
  call s:sign_init()
  call sign_unplace('ait_diag')
  let [l:e, l:w] = [0, 0]
  for l:i in getqflist()
    if !l:i.valid || l:i.bufnr <= 0 | continue | endif
    let l:warn = l:i.type =~? '[wn]'
    call sign_place(0, 'ait_diag', l:warn ? 'AitWarn' : 'AitErr', l:i.bufnr, {'lnum': l:i.lnum, 'priority': 12})
    if bufnr('%') == l:i.bufnr | if l:warn | let l:w += 1 | else | let l:e += 1 | endif | endif
  endfor
  let b:ait_diag = [l:e, l:w]
endfunction

" ---------- run (F5) ----------
function! ait#run() abort
  silent! update
  let l:ft = &filetype | let l:f = expand('%:p:S') | let l:out = shellescape(tempname()) | let l:cd = expand('%:p:h')
  if l:ft ==# 'python'
    let l:cmd = 'python3 ' . l:f
  elseif l:ft ==# 'sh' || l:ft ==# 'bash' || l:ft ==# 'zsh'
    let l:cmd = (getline(1) =~# 'zsh' ? 'zsh ' : 'bash ') . l:f
  elseif l:ft ==# 'c'
    let l:cmd = 'cc -Wall -g ' . l:f . ' -o ' . l:out . ' && ' . l:out
  elseif l:ft ==# 'cpp'
    let l:cmd = 'c++ -std=c++17 -Wall -g ' . l:f . ' -o ' . l:out . ' && ' . l:out
  elseif l:ft ==# 'rust'
    let l:root = s:project_root(['Cargo.toml'])
    if l:root !=# ''
      let l:cmd = 'cargo run' | let l:cd = l:root
    else
      let l:cmd = 'rustc --edition 2021 -o ' . l:out . ' ' . l:f . ' && ' . l:out
    endif
  else
    echo 'AI Terminal: ' . l:ft . ' 파일은 실행을 지원하지 않습니다 (python/c/cpp/rust/sh)'
    return
  endif
  botright 14new
  call term_start(['/bin/zsh', '-c', l:cmd . '; ec=$?; printf "\n\033[2m[종료코드 %d] q: 창 닫기\033[0m\n" $ec'], {'curwin': 1, 'cwd': l:cd})
  setlocal nonumber norelativenumber signcolumn=no
  stopinsert
endfunction

" ---------- format (F7) ----------
function! ait#format() abort
  let l:ft = &filetype | let l:cmd = ''
  if l:ft ==# 'python'
    let l:cmd = executable('ruff') ? 'ruff format -q -' : (executable('black') ? 'black -q -' : '')
  elseif l:ft ==# 'c' || l:ft ==# 'cpp'
    if executable('clang-format')
      let l:cmd = 'clang-format --assume-filename=' . shellescape(expand('%:t')) . (findfile('.clang-format', expand('%:p:h') . ';') ==# '' ? " --style='{BasedOnStyle: LLVM, IndentWidth: 4, ColumnLimit: 100}'" : '')
    endif
  elseif l:ft ==# 'rust'
    let l:cmd = executable('rustfmt') ? 'rustfmt --edition 2021 --emit stdout' : ''
  elseif l:ft ==# 'sh' || l:ft ==# 'bash'
    let l:cmd = executable('shfmt') ? 'shfmt -i 2' : ''
  endif
  let l:view = winsaveview()
  if l:cmd ==# ''
    silent keepjumps normal! gg=G
    call winrestview(l:view)
    echo '포매터가 없어 들여쓰기만 정리했습니다 (' . l:ft . ')'
    return
  endif
  let l:res = systemlist(l:cmd, getline(1, '$'))
  if v:shell_error
    echo '포맷 실패: ' . join(l:res[:2], ' | ')
    return
  endif
  if l:res !=# getline(1, '$')
    silent keepjumps call setline(1, l:res)
    if len(l:res) < line('$') | silent keepjumps execute (len(l:res) + 1) . ',$delete _' | endif
  endif
  call winrestview(l:view)
  echo '✔ 포맷 완료'
endfunction

" ---------- outline (<leader>o), project grep, header/source switch ----------
let s:outline = {
  \ 'python': '\v^\s*(async\s+)?(def|class)\s+\w+',
  \ 'c':      '\v^(\s*(struct|enum|union|typedef\s+struct)\s+\w+|[A-Za-z_][A-Za-z0-9_ \t\*]*[ \t\*]\w+\s*\([^;]*\)\s*(\{.*)?$)',
  \ 'cpp':    '\v^(\s*(struct|class|enum|namespace|union)\s+\w+|[A-Za-z_][A-Za-z0-9_ \t\*&:<>,~]*[ \t\*&:]\~?\w+\s*\([^;]*\)\s*(const)?\s*(\{.*)?$)',
  \ 'rust':   '\v^\s*(pub(\([^)]*\))?\s+)?(async\s+)?(unsafe\s+)?(fn|struct|enum|trait|impl|mod|const|static|type|macro_rules!)\s*\w*',
  \ 'sh':     '\v^\s*(function\s+\w+|\w+\s*\(\)\s*\{?)',
  \ }
function! ait#outline() abort
  let l:pat = get(s:outline, &filetype, '')
  if l:pat ==# ''
    echo 'AI Terminal: ' . &filetype . ' 파일은 개요를 지원하지 않습니다'
    return
  endif
  silent! execute 'lvimgrep /' . l:pat . '/j %'
  if empty(getloclist(0))
    echo '심볼이 없습니다'
    return
  endif
  call setloclist(0, [], 'a', {'title': 'Outline: ' . expand('%:t')})
  botright lopen 12
endfunction

function! ait#grep(pat) abort
  let l:old = &grepprg
  let &grepprg = executable('rg') ? 'rg --vimgrep --smart-case' : 'grep -rnIH --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=target'
  silent! execute 'grep! ' . a:pat . (executable('rg') ? '' : ' .')
  let &grepprg = l:old
  redraw!
  let l:n = len(getqflist())
  if l:n | botright copen 12 | else | cclose | echo '결과 없음' | endif
endfunction

function! ait#alt() abort
  let l:r = expand('%:p:r') | let l:e = expand('%:e')
  let l:map = {'c': ['h'], 'cpp': ['hpp', 'h', 'hh'], 'cc': ['hh', 'h', 'hpp'], 'cxx': ['hxx', 'h'], 'h': ['c', 'cpp', 'cc'], 'hpp': ['cpp', 'cc', 'cxx'], 'hh': ['cc', 'cpp']}
  for l:x in get(l:map, l:e, [])
    if filereadable(l:r . '.' . l:x)
      execute 'edit ' . fnameescape(l:r . '.' . l:x)
      return
    endif
  endfor
  echo '짝이 되는 헤더/소스 파일이 없습니다'
endfunction

function! ait#trim() abort
  let l:v = winsaveview()
  silent! keeppatterns %s/\s\+$//e
  call winrestview(l:v)
endfunction

" ---------- cheat sheet ----------
function! s:help_filter(id, key) abort
  if index(['q', "\<CR>", ' ', 'x', '?'], a:key) >= 0
    call popup_close(a:id)
  endif
  return 1
endfunction

function! ait#help() abort
  let l:lines = [
    \ ' AI Terminal · Vim   (Space = leader · Mac: fn 없이 사용 가능)',
    \ '',
    \ ' Space r    실행 (py/c/cpp/rust/sh)      = fn+F5',
    \ ' Space c    문법·린트 검사 → 줄에 ●        = fn+F6   (]d [d 이동)',
    \ ' Space =    포맷 (ruff/black·clang-format·rustfmt·shfmt) = fn+F7',
    \ ' Space ?    이 도움말                       = fn+F1',
    \ ' Space e    파일 탐색기      Space f  파일 찾기(:find)',
    \ ' Space o    함수/클래스 개요  Space g  프로젝트 검색(:Grep)',
    \ ' Space a    AI 에게 수정 요청(줄/선택) → diff 확인 후 적용 (:AitAI)',
    \ ' gd / K      정의로 이동 / 문서 보기 (LSP: clangd·rust-analyzer·pyright)',
    \ ' ]d [d       다음/이전 진단   Space d  진단 목록',
    \ ' Space h    헤더 ↔ 소스(C/C++)   Space b  버퍼 전환',
    \ ' Space w    저장   Space q  종료   Space /  검색 하이라이트 끄기',
    \ ' gcc / gc   주석 토글        %  짝 괄호/블록 이동',
    \ ' Tab        자동완성          ⌃h ⌃j ⌃k ⌃l  창 이동',
    \ ' y / p      macOS 클립보드와 공유 (⌘C ⌘V 와 같은 클립보드)',
    \ ' 줄 왼쪽 ▎  git 변경 (녹색 추가 · 파랑 수정 · 빨강 삭제)',
    \ ' :AitTheme dark|light   :AitTrim (줄 끝 공백 제거)',
    \ ' esc esc    터미널 창에서 일반 모드로',
    \ ]
  call popup_create(l:lines, {'title': ' ✦ 단축키 (q: 닫기) ', 'border': [], 'padding': [0, 1, 0, 1], 'minwidth': 62, 'highlight': 'Pmenu', 'borderhighlight': ['AitBorder'], 'close': 'click', 'filter': function('s:help_filter'), 'mapping': 0, 'zindex': 200})
endfunction

function! ait#themes(A, L, P) abort
  return ['dark', 'light']
endfunction
