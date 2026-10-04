" AI Terminal bundled Vim setup — loaded through $VIMINIT when vim is started inside AI Terminal.
" No downloads / external plugins: everything below is plain Vim 9 script + built-in optional packages.
" Disable: AIT_VIM=0 in the environment, or start vim with `-u NONE` / `-u ~/.vimrc`.
if exists('g:ait_loaded') || v:version < 900
  finish
endif
let g:ait_loaded = 1
let s:dir = fnamemodify(resolve(expand('<sfile>:p')), ':h')
let g:ait_dir = s:dir

set nocompatible
let &runtimepath = substitute(s:dir, ',', '\\,', 'g') . ',' . &runtimepath . ',' . substitute(s:dir, ',', '\\,', 'g') . '/after'

" ---------- basics ----------
set encoding=utf-8 fileencodings=utf-8,cp949,euc-kr,latin1
set hidden autoread confirm
set backspace=indent,eol,start
set mouse=a
set ttimeout ttimeoutlen=40 timeoutlen=600 updatetime=300
set splitright splitbelow
set scrolloff=6 sidescrolloff=8 nowrap
set ignorecase smartcase incsearch hlsearch
set wildmenu wildmode=longest:full,full wildignore+=*/.git/*,*/node_modules/*,*/target/*,*.o,*.pyc,__pycache__
set path+=**
set formatoptions+=j
set nrformats-=octal
set display=truncate
set laststatus=2 showcmd noshowmode cmdheight=1
set shortmess+=cI
set signcolumn=yes
set cursorline
set number relativenumber
set foldmethod=indent foldlevelstart=99 foldnestmax=4
set complete=.,w,b,u,t,i
set completeopt=menuone,popup,noselect
set nobackup nowritebackup noswapfile
set clipboard=unnamed
set list
set fillchars=vert:│,fold:·,eob:\ 
set matchpairs+=<:>
if exists('+autocomplete')
  set autocomplete
endif

" true colour + cursor shape through the AI Terminal (xterm.js) PTY
if &term =~# 'xterm\|tmux\|screen' || $COLORTERM ==# 'truecolor'
  let &t_8f = "\<Esc>[38;2;%lu;%lu;%lum"
  let &t_8b = "\<Esc>[48;2;%lu;%lu;%lum"
  let &t_SI = "\<Esc>[6 q"
  let &t_SR = "\<Esc>[4 q"
  let &t_EI = "\<Esc>[2 q"
  set termguicolors
endif

filetype plugin indent on
syntax on

" ---------- built-in optional packages (plugin-like features) ----------
silent! packadd comment      " gc / gcc : toggle comments
silent! packadd matchit      " % jumps between if/else/fi, tags, ...
silent! packadd editorconfig " honours .editorconfig
silent! packadd hlyank       " flash yanked text
silent! packadd helptoc
let g:netrw_banner = 0
let g:netrw_liststyle = 3
let g:netrw_winsize = 26
let g:netrw_browse_split = 4
let g:netrw_altv = 1

" ---------- colours (follows the app theme) ----------
function! s:theme() abort
  let l:f = $AIT_THEME_FILE
  if l:f !=# '' && filereadable(l:f)
    return get(readfile(l:f, '', 1), 0, '') =~# 'light' ? 'light' : 'dark'
  endif
  return 'dark'
endfunction
execute 'colorscheme ait' . s:theme()
command! -nargs=1 -complete=customlist,ait#themes AitTheme execute 'colorscheme ait' . <q-args>

" ---------- mappings ----------
let mapleader = ' '
nnoremap <silent> <leader>e :Lexplore<CR>
nnoremap <leader>f :find *
nnoremap <leader>b :ls<CR>:b<Space>
nnoremap <silent> <leader>w :update<CR>
nnoremap <silent> <leader>q :q<CR>
nnoremap <silent> <leader>/ :nohlsearch<CR>
nnoremap <silent> <leader>o :call ait#outline()<CR>
nnoremap <silent> <leader>h :call ait#alt()<CR>
nnoremap <leader>g :Grep<Space>
nnoremap <silent> <leader>n :set number! relativenumber!<CR>
nnoremap <silent> <leader>t :tabnew<CR>
nnoremap <silent> <leader>? :call ait#help()<CR>
" Mac laptops: F5-F7 are media keys (need fn), so every function key also has a Space-leader twin
nnoremap <silent> <leader>r :call ait#run()<CR>
nnoremap <silent> <leader>c :call ait#check()<CR>
nnoremap <silent> <leader>= :call ait#format()<CR>
nnoremap <silent> <F5> :call ait#run()<CR>
nnoremap <silent> <F6> :call ait#check()<CR>
nnoremap <silent> <F7> :call ait#format()<CR>
nnoremap <silent> <F1> :call ait#help()<CR>
nnoremap <silent> ]d :call ait#lsp#jump(1)<CR>
nnoremap <silent> [d :call ait#lsp#jump(-1)<CR>
nnoremap <silent> <leader>d :call ait#lsp#list()<CR>
" inline AI edit (needs the AI Terminal app): normal = current line, visual = selection
nnoremap <silent> <leader>a :call ait#ai#ask(line('.'), line('.'))<CR>
xnoremap <silent> <leader>a :<C-u>call ait#ai#ask(line("'<"), line("'>"))<CR>
nnoremap <silent> <C-h> <C-w>h
nnoremap <silent> <C-j> <C-w>j
nnoremap <silent> <C-k> <C-w>k
nnoremap <silent> <C-l> <C-w>l
vnoremap < <gv
vnoremap > >gv
tnoremap <Esc><Esc> <C-\><C-n>

" smart completion / pairs
inoremap <expr> <Tab>   ait#tab()
inoremap <expr> <S-Tab> pumvisible() ? "\<C-p>" : "\<S-Tab>"
inoremap <expr> <CR>    pumvisible() ? "\<C-y>" : ait#cr()
inoremap <expr> <BS>    ait#bs()
inoremap <expr> (  ait#open('(', ')')
inoremap <expr> [  ait#open('[', ']')
inoremap <expr> {  ait#open('{', '}')
inoremap <expr> )  ait#close(')')
inoremap <expr> ]  ait#close(']')
inoremap <expr> }  ait#close('}')
inoremap <expr> "  ait#quote('"')
inoremap <expr> '  ait#quote("'")

command! -nargs=+ Grep call ait#grep(<q-args>)
command! AitTrim call ait#trim()
command! AitHelp call ait#help()
command! -nargs=* -range AitAI call ait#ai#edit(<q-args>, <line1>, <line2>)
command! AitLspInfo call ait#lsp#info()
command! AitLspStop call ait#lsp#stop()
command! AitOutline call ait#outline()

" ---------- autocmds ----------
augroup AitVim
  autocmd!
  autocmd InsertEnter * if &number | setlocal norelativenumber | endif
  autocmd InsertLeave * if &number | setlocal relativenumber | endif
  autocmd ModeChanged * redrawstatus
  autocmd BufEnter,BufWritePost,FocusGained * call ait#gitrefresh()
  autocmd FileType * call ait#guides()
  autocmd OptionSet shiftwidth,expandtab call ait#guides()
  autocmd FileType c,cpp,rust,python,sh,bash call ait#lsp#attach()
  autocmd CursorHold  * call ait#illum() | call ait#lsp#hint()
  autocmd VimLeavePre * call ait#lsp#stop()
  autocmd CursorMoved,InsertEnter * call ait#illum_clear()
  autocmd TerminalOpen * if &buftype ==# 'terminal' | nnoremap <buffer> <silent> q :close<CR> | setlocal nonumber norelativenumber signcolumn=no | endif
  autocmd BufReadPost * if line("'\"") > 1 && line("'\"") <= line('$') && &filetype !~# 'commit' | execute "normal! g`\"" | endif
  autocmd VimLeave * call echoraw("\<Esc>[0 q")
  autocmd Syntax * call ait#todo()
augroup END

set statusline=%!ait#statusline()
set tabline=%!ait#tabline()
call ait#guides()

" the user's own vimrc is skipped when VIMINIT is set, so load it here (it wins over the defaults above)
for s:rc in [expand('~/.vimrc'), expand('~/.vim/vimrc')]
  if filereadable(s:rc)
    execute 'source ' . fnameescape(s:rc)
    break
  endif
endfor
