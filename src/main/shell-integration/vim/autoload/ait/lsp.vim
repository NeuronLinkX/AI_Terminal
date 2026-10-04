scriptencoding utf-8
" ---------- tiny LSP client (diagnostics · hover · go to definition) ----------
" Talks to real language servers over Vim's built-in JSON-RPC channel (job in 'lsp' mode). No plugin, no download: a server is
" used only when it is already installed:  C/C++ clangd · Rust rust-analyzer · Python pyright-langserver / pylsp ·
" Shell bash-language-server.  Disable with `let g:ait_lsp = 0` or AIT_LSP=0.
"   gd  go to definition (falls back to Vim's gd)     K   hover documentation (falls back to keywordprg)
"   ]d [d  next / previous diagnostic                 Space d  list of diagnostics     :AitLspInfo  :AitLspStop
" Diagnostics appear as ● in the sign column, as ✖/▲ counts in the status line, and as a message under the cursor.
let s:srv = {}    " key -> {job, ch, state, name, root, caps}
let s:bufs = {}   " bufnr -> {key, ft, version, uri, timer}
let s:diag = {}   " uri -> [LSP diagnostics]
let s:signs = 0

let s:works_cache = {}
function! s:works(bin) abort
  if !has_key(s:works_cache, a:bin)
    call system(shellescape(a:bin) . ' --version')
    let s:works_cache[a:bin] = v:shell_error == 0
  endif
  return s:works_cache[a:bin]
endfunction

function! s:cmd_for(ft) abort
  if a:ft ==# 'c' || a:ft ==# 'cpp'
    for l:c in ['clangd', '/opt/homebrew/opt/llvm/bin/clangd']
      if executable(l:c) | return [l:c, '--log=error', '--header-insertion=never'] | endif
    endfor
  elseif a:ft ==# 'rust'
    " the rustup proxy ~/.cargo/bin/rust-analyzer exists even when the component is not installed: only use a working one
    if executable('rust-analyzer') && s:works('rust-analyzer') | return ['rust-analyzer'] | endif
  elseif a:ft ==# 'python'
    if executable('pyright-langserver') | return ['pyright-langserver', '--stdio'] | endif
    if executable('pylsp') | return ['pylsp'] | endif
  elseif a:ft ==# 'sh' || a:ft ==# 'bash'
    if executable('bash-language-server') | return ['bash-language-server', 'start'] | endif
  endif
  return []
endfunction

let s:lang_id = {'c': 'c', 'cpp': 'cpp', 'rust': 'rust', 'python': 'python', 'sh': 'shellscript', 'bash': 'shellscript'}
let s:markers = {'c': ['compile_commands.json', '.clangd', '.git'], 'cpp': ['compile_commands.json', '.clangd', '.git'], 'rust': ['Cargo.toml', '.git'], 'python': ['pyproject.toml', 'setup.py', '.git'], 'sh': ['.git'], 'bash': ['.git']}

function! s:root(ft) abort
  let l:start = resolve(expand('%:p:h'))
  for l:m in get(s:markers, a:ft, ['.git'])
    let l:f = findfile(l:m, l:start . ';')
    if l:f !=# '' | return fnamemodify(l:f, ':p:h') | endif
    let l:d = finddir(l:m, l:start . ';')
    if l:d !=# '' | return fnamemodify(l:d, ':p:h:h') | endif
  endfor
  return l:start
endfunction

function! s:uri(path) abort
  let l:p = substitute(a:path, '[^A-Za-z0-9/._~-]', '\=printf("%%%02X", char2nr(submatch(0)))', 'g')
  return 'file://' . l:p
endfunction
function! s:path(uri) abort
  let l:p = substitute(a:uri, '^file://', '', '')
  return substitute(l:p, '%\(\x\x\)', '\=nr2char("0x" . submatch(1))', 'g')
endfunction

" byte column <-> UTF-16 column (LSP positions count UTF-16 code units)
function! s:u16(lnum, bytecol) abort
  let l:line = getline(a:lnum)
  return exists('*charidx') ? charidx(l:line, a:bytecol, 0, 1) : a:bytecol
endfunction
function! s:bytecol(lnum, u16) abort
  let l:line = getline(a:lnum)
  return exists('*byteidx') ? max([byteidx(l:line, a:u16, 1), 0]) : a:u16
endfunction

" ---------- server lifecycle ----------
function! s:start(key, cmd, root) abort
  let l:job = job_start(a:cmd, {'in_mode': 'lsp', 'out_mode': 'lsp', 'err_io': 'null', 'callback': function('s:on_msg', [a:key]), 'exit_cb': function('s:on_exit', [a:key]), 'cwd': a:root})
  if job_status(l:job) !=# 'run' | return | endif
  let s:srv[a:key] = {'job': l:job, 'ch': job_getchannel(l:job), 'state': 'starting', 'name': fnamemodify(a:cmd[0], ':t'), 'root': a:root, 'caps': {}}
  let l:caps = {'textDocument': {'synchronization': {'didSave': v:true}, 'publishDiagnostics': {}, 'hover': {'contentFormat': ['plaintext', 'markdown']}, 'definition': {'linkSupport': v:false}}, 'general': {'positionEncodings': ['utf-16']}}
  call ch_sendexpr(s:srv[a:key].ch, {'method': 'initialize', 'params': {'processId': getpid(), 'rootUri': s:uri(a:root), 'workspaceFolders': [{'uri': s:uri(a:root), 'name': fnamemodify(a:root, ':t')}], 'capabilities': l:caps}}, {'callback': function('s:on_init', [a:key])})
endfunction

function! s:on_init(key, ch, resp) abort
  if !has_key(s:srv, a:key) | return | endif
  if type(a:resp) != v:t_dict || !has_key(a:resp, 'result')
    let s:srv[a:key].state = 'dead'
    return
  endif
  let s:srv[a:key].caps = get(a:resp.result, 'capabilities', {})
  let s:srv[a:key].state = 'ready'
  call ch_sendexpr(s:srv[a:key].ch, {'method': 'initialized', 'params': {}})
  for l:b in keys(s:bufs)
    if s:bufs[l:b].key ==# a:key | call s:open(str2nr(l:b)) | endif
  endfor
endfunction

function! s:on_exit(key, job, status) abort
  if has_key(s:srv, a:key) | call remove(s:srv, a:key) | endif
  for l:b in keys(s:bufs)
    if s:bufs[l:b].key ==# a:key | let s:bufs[l:b].open = 0 | endif
  endfor
endfunction

function! s:on_msg(key, ch, msg) abort
  if type(a:msg) != v:t_dict || !has_key(a:msg, 'method') | return | endif
  if a:msg.method ==# 'textDocument/publishDiagnostics'
    let l:p = a:msg.params
    let s:diag[l:p.uri] = get(l:p, 'diagnostics', [])
    for l:b in keys(s:bufs)
      if s:bufs[l:b].uri ==# l:p.uri | call s:render(str2nr(l:b)) | endif
    endfor
  elseif has_key(a:msg, 'id')
    " a request from the server (workspace/configuration, window/workDoneProgress/create …): answer with an empty result
    call ch_sendexpr(a:ch, {'id': a:msg.id, 'result': v:null})
  endif
endfunction

" ---------- documents ----------
function! s:text(bufnr) abort
  return join(getbufline(a:bufnr, 1, '$'), "\n") . "\n"
endfunction

function! s:open(bufnr) abort
  let l:b = get(s:bufs, a:bufnr, {})
  if empty(l:b) || get(l:b, 'open', 0) || !has_key(s:srv, l:b.key) || s:srv[l:b.key].state !=# 'ready' | return | endif
  let l:b.open = 1
  let l:b.version = 1
  call ch_sendexpr(s:srv[l:b.key].ch, {'method': 'textDocument/didOpen', 'params': {'textDocument': {'uri': l:b.uri, 'languageId': get(s:lang_id, l:b.ft, l:b.ft), 'version': 1, 'text': s:text(a:bufnr)}}})
endfunction

function! s:flush(bufnr, timer) abort
  let l:b = get(s:bufs, a:bufnr, {})
  if empty(l:b) || !get(l:b, 'open', 0) || !has_key(s:srv, l:b.key) | return | endif
  let l:b.version += 1
  let l:b.timer = 0
  call ch_sendexpr(s:srv[l:b.key].ch, {'method': 'textDocument/didChange', 'params': {'textDocument': {'uri': l:b.uri, 'version': l:b.version}, 'contentChanges': [{'text': s:text(a:bufnr)}]}})
endfunction

function! ait#lsp#changed() abort
  let l:n = bufnr('%')
  let l:b = get(s:bufs, l:n, {})
  if empty(l:b) | return | endif
  if get(l:b, 'timer', 0) | call timer_stop(l:b.timer) | endif
  let l:b.timer = timer_start(350, function('s:flush', [l:n]))
endfunction

function! ait#lsp#saved() abort
  let l:b = get(s:bufs, bufnr('%'), {})
  if empty(l:b) || !get(l:b, 'open', 0) || !has_key(s:srv, l:b.key) | return | endif
  call ch_sendexpr(s:srv[l:b.key].ch, {'method': 'textDocument/didSave', 'params': {'textDocument': {'uri': l:b.uri}}})
endfunction

function! ait#lsp#closed(bufnr) abort
  let l:b = get(s:bufs, a:bufnr, {})
  if empty(l:b) | return | endif
  if get(l:b, 'open', 0) && has_key(s:srv, l:b.key)
    call ch_sendexpr(s:srv[l:b.key].ch, {'method': 'textDocument/didClose', 'params': {'textDocument': {'uri': l:b.uri}}})
  endif
  call remove(s:bufs, a:bufnr)
endfunction

function! ait#lsp#attach() abort
  if get(g:, 'ait_lsp', 1) == 0 || $AIT_LSP ==# '0' || &buftype !=# '' || expand('%:p') ==# '' | return | endif
  let l:cmd = s:cmd_for(&filetype)
  if empty(l:cmd) | return | endif
  let l:root = s:root(&filetype)
  let l:key = l:cmd[0] . '|' . l:root
  let l:n = bufnr('%')
  if has_key(s:bufs, l:n) | return | endif
  let s:bufs[l:n] = {'key': l:key, 'ft': &filetype, 'version': 0, 'open': 0, 'timer': 0, 'uri': s:uri(resolve(expand('%:p')))}
  if !has_key(s:srv, l:key) | call s:start(l:key, l:cmd, l:root) | endif
  call s:open(l:n)
  augroup AitLspBuf
    execute 'autocmd! * <buffer=' . l:n . '>'
    autocmd TextChanged,TextChangedI <buffer> call ait#lsp#changed()
    autocmd BufWritePost <buffer> call ait#lsp#saved()
    autocmd BufUnload <buffer> call ait#lsp#closed(str2nr(expand('<abuf>')))
  augroup END
  nnoremap <silent> <buffer> gd :call ait#lsp#definition()<CR>
  nnoremap <silent> <buffer> K :call ait#lsp#hover()<CR>
endfunction

function! ait#lsp#stop() abort
  for l:k in keys(s:srv)
    call job_stop(s:srv[l:k].job)
  endfor
  let s:srv = {}
  for l:b in keys(s:bufs) | let s:bufs[l:b].open = 0 | endfor
endfunction

" ---------- diagnostics ----------
function! s:sign_init() abort
  if s:signs | return | endif
  let s:signs = 1
  call sign_define('AitLspErr',  {'text': '●', 'texthl': 'AitSignErr'})
  call sign_define('AitLspWarn', {'text': '●', 'texthl': 'AitSignWarn'})
endfunction

function! s:render(bufnr) abort
  if !bufexists(a:bufnr) | return | endif
  call s:sign_init()
  call sign_unplace('ait_lsp', {'buffer': a:bufnr})
  let l:items = []
  let [l:e, l:w] = [0, 0]
  for l:d in get(s:diag, s:bufs[a:bufnr].uri, [])
    let l:sev = get(l:d, 'severity', 1)
    let l:lnum = l:d.range.start.line + 1
    call sign_place(0, 'ait_lsp', l:sev == 1 ? 'AitLspErr' : 'AitLspWarn', a:bufnr, {'lnum': l:lnum, 'priority': 13})
    if l:sev == 1 | let l:e += 1 | elseif l:sev == 2 | let l:w += 1 | endif
    call add(l:items, {'bufnr': a:bufnr, 'lnum': l:lnum, 'col': s:bytecol(l:lnum, l:d.range.start.character) + 1, 'text': substitute(get(l:d, 'message', ''), '\n.*', '', ''), 'type': l:sev == 1 ? 'E' : l:sev == 2 ? 'W' : 'I'})
  endfor
  call setbufvar(a:bufnr, 'ait_diag', [l:e, l:w])
  call setbufvar(a:bufnr, 'ait_lsp_items', l:items)
  for l:win in win_findbuf(a:bufnr)
    call setloclist(l:win, [], 'r', {'title': 'LSP ' . s:srv_name(a:bufnr), 'items': l:items})
  endfor
  redrawstatus
endfunction

function! s:srv_name(bufnr) abort
  let l:b = get(s:bufs, a:bufnr, {})
  return !empty(l:b) && has_key(s:srv, l:b.key) ? s:srv[l:b.key].name : ''
endfunction

" ]d [d : LSP diagnostics of this buffer when there are any, otherwise the quickfix list (F6 check)
function! ait#lsp#jump(dir) abort
  let l:items = get(b:, 'ait_lsp_items', [])
  if empty(l:items)
    execute (a:dir > 0 ? 'silent! cnext' : 'silent! cprevious')
    return
  endif
  let l:cur = line('.')
  let l:sorted = sort(copy(l:items), {a, b -> a.lnum == b.lnum ? a.col - b.col : a.lnum - b.lnum})
  let l:pick = {}
  if a:dir > 0
    for l:i in l:sorted | if l:i.lnum > l:cur | let l:pick = l:i | break | endif | endfor
    if empty(l:pick) | let l:pick = l:sorted[0] | endif
  else
    for l:i in reverse(copy(l:sorted)) | if l:i.lnum < l:cur | let l:pick = l:i | break | endif | endfor
    if empty(l:pick) | let l:pick = l:sorted[-1] | endif
  endif
  call cursor(l:pick.lnum, l:pick.col)
  call ait#lsp#hint()
endfunction

function! ait#lsp#list() abort
  if empty(get(b:, 'ait_lsp_items', []))
    echo 'LSP: 진단 없음'
    return
  endif
  lopen 8
endfunction

" message of the diagnostic on the cursor line (CursorHold)
function! ait#lsp#hint() abort
  if !has_key(s:bufs, bufnr('%')) | return | endif
  for l:d in get(s:diag, s:bufs[bufnr('%')].uri, [])
    if l:d.range.start.line + 1 == line('.')
      let l:msg = substitute(get(l:d, 'message', ''), '\n.*', '', '')
      echohl WarningMsg | echo strcharpart('✖ ' . l:msg, 0, &columns - 12) | echohl None
      return
    endif
  endfor
endfunction

" ---------- hover / definition ----------
function! s:pos() abort
  return {'line': line('.') - 1, 'character': s:u16(line('.'), col('.') - 1)}
endfunction

function! s:ready() abort
  let l:b = get(s:bufs, bufnr('%'), {})
  return !empty(l:b) && get(l:b, 'open', 0) && has_key(s:srv, l:b.key) && s:srv[l:b.key].state ==# 'ready'
endfunction

function! ait#lsp#hover() abort
  if !s:ready()
    execute 'normal! K'
    return
  endif
  let l:b = s:bufs[bufnr('%')]
  call ch_sendexpr(s:srv[l:b.key].ch, {'method': 'textDocument/hover', 'params': {'textDocument': {'uri': l:b.uri}, 'position': s:pos()}}, {'callback': function('s:on_hover')})
endfunction

function! s:flat(c) abort
  if type(a:c) == v:t_string | return a:c | endif
  if type(a:c) == v:t_dict | return get(a:c, 'value', '') | endif
  if type(a:c) == v:t_list | return join(map(copy(a:c), 's:flat(v:val)'), "\n\n") | endif
  return ''
endfunction

function! s:on_hover(ch, resp) abort
  let l:r = type(a:resp) == v:t_dict ? get(a:resp, 'result', v:null) : v:null
  if type(l:r) != v:t_dict | echo 'LSP: 정보 없음' | return | endif
  let l:lines = filter(split(substitute(s:flat(get(l:r, 'contents', '')), '```\w*', '', 'g'), "\n"), 'v:val !=# ""')
  if empty(l:lines) | echo 'LSP: 정보 없음' | return | endif
  call popup_atcursor(l:lines[:24], {'border': [], 'padding': [0, 1, 0, 1], 'maxwidth': 80, 'maxheight': 20, 'highlight': 'Pmenu', 'borderhighlight': ['AitBorder'], 'moved': 'any', 'close': 'click', 'zindex': 150})
endfunction

function! ait#lsp#definition() abort
  if !s:ready()
    execute 'normal! gd'
    return
  endif
  let l:b = s:bufs[bufnr('%')]
  call ch_sendexpr(s:srv[l:b.key].ch, {'method': 'textDocument/definition', 'params': {'textDocument': {'uri': l:b.uri}, 'position': s:pos()}}, {'callback': function('s:on_def')})
endfunction

function! s:on_def(ch, resp) abort
  let l:r = type(a:resp) == v:t_dict ? get(a:resp, 'result', v:null) : v:null
  if type(l:r) == v:t_list | let l:r = empty(l:r) ? v:null : l:r[0] | endif
  if type(l:r) != v:t_dict | echo 'LSP: 정의를 찾지 못했습니다' | return | endif
  let l:uri = get(l:r, 'targetUri', get(l:r, 'uri', ''))
  let l:rng = get(l:r, 'targetSelectionRange', get(l:r, 'range', {}))
  if l:uri ==# '' || empty(l:rng) | return | endif
  normal! m'
  let l:file = s:path(l:uri)
  " macOS: /var → /private/var, /tmp → /private/tmp — compare real paths or the same file would be opened twice
  if resolve(fnamemodify(l:file, ':p')) !=# resolve(expand('%:p')) | execute 'edit ' . fnameescape(l:file) | endif
  let l:ln = l:rng.start.line + 1
  call cursor(l:ln, s:bytecol(l:ln, l:rng.start.character) + 1)
  normal! zz
endfunction

" ---------- status ----------
function! ait#lsp#status() abort
  let l:b = get(s:bufs, bufnr('%'), {})
  if empty(l:b) || !has_key(s:srv, l:b.key) | return '' | endif
  return s:srv[l:b.key].name . (s:srv[l:b.key].state ==# 'ready' ? '' : '…')
endfunction

function! ait#lsp#info() abort
  if empty(s:srv) | echo 'LSP: 실행 중인 서버 없음 (clangd · rust-analyzer · pyright-langserver · pylsp · bash-language-server 가 설치되어 있어야 합니다)' | return | endif
  for l:k in keys(s:srv)
    echo printf('%s  %s  root=%s  buffers=%d', s:srv[l:k].name, s:srv[l:k].state, s:srv[l:k].root, len(filter(copy(s:bufs), 'v:val.key ==# l:k')))
  endfor
endfunction

" for tests / :echo ait#lsp#state()
function! ait#lsp#state() abort
  return {'servers': map(copy(s:srv), 'v:val.state'), 'bufs': map(copy(s:bufs), '{"uri": v:val.uri, "open": v:val.open}'), 'diag_uris': keys(s:diag)}
endfunction
