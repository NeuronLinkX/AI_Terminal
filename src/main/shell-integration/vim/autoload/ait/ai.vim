scriptencoding utf-8
" ---------- :AitAI — inline AI edit ----------
" Sends the selected lines + your instruction to AI Terminal (private escape sequence ESC]777;ait;A;<base64 json>BEL),
" which asks the model you chose there and writes the answer to a reply file this script polls. The proposed result is
" shown as a diff and applied ONLY after you confirm; `u` undoes it. Secrets in the selection are never sent.
"   Space a  (normal: current line · visual: selection)      :[range]AitAI {instruction}
let s:pending = {}

function! s:tmpdir() abort
  return substitute($TMPDIR !=# '' ? $TMPDIR : '/tmp', '/\+$', '', '')
endfunction

function! ait#ai#ask(l1, l2) abort
  let l:in = input('AI 지시 (예: 타입 힌트 추가 / 예외 처리 / 영어 주석): ')
  redraw
  if trim(l:in) ==# '' | return | endif
  call ait#ai#edit(l:in, a:l1, a:l2)
endfunction

function! ait#ai#edit(instr, l1, l2) abort
  if !empty(s:pending)
    echohl WarningMsg | echo 'AI 요청이 이미 진행 중입니다' | echohl None
    return
  endif
  if trim(a:instr) ==# ''
    return ait#ai#ask(a:l1, a:l2)
  endif
  let l:id = printf('v%s%d', strftime('%H%M%S'), getpid())
  let l:orig = getline(a:l1, a:l2)
  let l:json = json_encode({'id': l:id, 'instruction': a:instr, 'filetype': &filetype, 'code': join(l:orig, "\n"), 'before': join(getline(max([1, a:l1 - 40]), a:l1 - 1), "\n"), 'after': join(getline(a:l2 + 1, min([line('$'), a:l2 + 20])), "\n")})
  let l:b64 = substitute(system('base64 | tr -d "\n"', l:json), '\n', '', 'g')
  call echoraw("\<Esc>]777;ait;A;" . l:b64 . "\x07")
  let s:pending = {'id': l:id, 'buf': bufnr('%'), 'l1': a:l1, 'l2': a:l2, 'orig': l:orig, 'file': s:tmpdir() . '/ait-reply-' . l:id . '.json', 't0': reltime(), 'ft': &filetype}
  let g:ait_ai_busy = 1
  let s:timer = timer_start(300, function('s:poll'), {'repeat': -1})
  redrawstatus
  echo '✦ AI 에게 요청했습니다… (응답을 기다리는 중에도 편집할 수 있습니다)'
endfunction

function! s:finish() abort
  if exists('s:timer') | call timer_stop(s:timer) | unlet s:timer | endif
  let s:pending = {}
  let g:ait_ai_busy = 0
  redrawstatus
endfunction

function! s:poll(timer) abort
  if empty(s:pending) | call timer_stop(a:timer) | return | endif
  let l:p = s:pending
  if filereadable(l:p.file)
    let l:res = {}
    try
      let l:res = json_decode(join(readfile(l:p.file), "\n"))
    catch
      " the host may still be writing: try again on the next tick (a hard failure is caught by the timeout)
      if reltimefloat(reltime(l:p.t0)) < 250 | return | endif
    endtry
    call delete(l:p.file)
    call s:finish()
    call s:done(l:p, l:res)
    return
  endif
  if reltimefloat(reltime(l:p.t0)) > 250
    call s:finish()
    echohl WarningMsg | echo 'AI 응답 시간이 초과되었습니다' | echohl None
  endif
endfunction

function! s:done(p, res) abort
  if type(a:res) != v:t_dict || !get(a:res, 'ok', 0)
    echohl ErrorMsg | echo 'AI: ' . (type(a:res) == v:t_dict ? get(a:res, 'error', '요청 실패') : '응답을 해석하지 못했습니다') | echohl None
    return
  endif
  let l:new = split(substitute(a:res.code, '\n\+$', '', ''), "\n", 1)
  if getbufline(a:p.buf, a:p.l1, a:p.l2) !=# a:p.orig
    echohl WarningMsg | echo 'AI 응답이 도착했지만 그 사이 해당 줄이 바뀌어 적용하지 않았습니다' | echohl None
    return
  endif
  if l:new ==# a:p.orig
    echo 'AI: 바꿀 내용이 없습니다'
    return
  endif
  " diff preview: the whole file with the replacement next to the current one
  let l:all = getbufline(a:p.buf, 1, '$')
  let l:after = l:all[: a:p.l1 - 2] + l:new + l:all[a:p.l2 :]
  let l:cur = win_getid()
  execute 'vnew'
  call setline(1, l:after)
  setlocal buftype=nofile bufhidden=wipe noswapfile nomodifiable
  let &l:filetype = a:p.ft
  file [AI 제안]
  diffthis
  let l:prev = win_getid()
  call win_gotoid(l:cur)
  diffthis
  redraw
  let l:ans = confirm('AI 가 제안한 수정을 적용할까요?  (적용 후에도 u 로 되돌릴 수 있습니다)', "&Apply 적용\n&Cancel 취소", 2)
  call win_gotoid(l:prev)
  bwipeout!
  call win_gotoid(l:cur)
  diffoff!
  redraw
  if l:ans != 1
    echo 'AI 수정을 적용하지 않았습니다'
    return
  endif
  call deletebufline(a:p.buf, a:p.l1, a:p.l2)
  call appendbufline(a:p.buf, a:p.l1 - 1, l:new)
  call cursor(a:p.l1, 1)
  echo '✔ AI 수정을 적용했습니다 (' . len(a:p.orig) . '줄 → ' . len(l:new) . '줄, u 로 되돌리기)'
endfunction
