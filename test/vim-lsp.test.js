'use strict';
// The bundled vim LSP client against a REAL language server (clangd, rust-analyzer when installed) driven by a real headless Vim.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const VIM_DIR = path.join(__dirname, '..', 'src', 'main', 'shell-integration', 'vim');
const has = (cmd) => { try { execFileSync('/usr/bin/which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; } };
const clangd = ['clangd', '/opt/homebrew/opt/llvm/bin/clangd'].find((c) => c.startsWith('/') ? fs.existsSync(c) : has(c));
const vimOk = has('vim') && /VIM - Vi IMproved 9/.test(spawnSync('vim', ['--version'], { encoding: 'utf8' }).stdout || '');

function runVim(script, timeout = 90000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-vimlsp-'));
  const sf = path.join(dir, 't.vim');
  fs.writeFileSync(sf, script.replace(/__OUT__/g, path.join(dir, 'out.txt')).replace(/__VIM__/g, VIM_DIR));
  const r = spawnSync('vim', ['-Nu', 'NONE', '-es', '-S', sf, '-c', 'qa!'], { encoding: 'utf8', timeout, env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/opt/llvm/bin` } });
  const out = fs.existsSync(path.join(dir, 'out.txt')) ? fs.readFileSync(path.join(dir, 'out.txt'), 'utf8') : '';
  return { out, status: r.status, dir };
}

test('vim LSP (clangd): diagnostics, definition, hover and the status line from a real server', { skip: !vimOk || !clangd }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-c-'));
  const file = path.join(dir, 'a.c');
  fs.writeFileSync(file, '#include <stdio.h>\nint add(int a, int b) { return a + b; }\nint main(void) {\n  int x = add(1, 2)\n  undefined_fn(x);\n  return 0;\n}\n');
  const r = runVim(`
set nocompatible encoding=utf-8
let &runtimepath = '__VIM__,' . &runtimepath
filetype plugin on
syntax on
execute 'edit ${file}'
set filetype=c
call ait#lsp#attach()
let out = []
for i in range(80)
  sleep 250m
  if get(b:, 'ait_diag', [0, 0])[0] > 0 | break | endif
endfor
call add(out, 'diag=' . string(get(b:, 'ait_diag', [])))
call add(out, 'items=' . len(get(b:, 'ait_lsp_items', [])))
call add(out, 'status=' . ait#lsp#status())
" go to definition from the call on line 4 (col of 'add')
call cursor(4, 11)
call ait#lsp#definition()
for i in range(20) | sleep 200m | if line('.') == 2 | break | endif | endfor
call add(out, 'def_line=' . line('.'))
" hover on the definition
call cursor(2, 6)
call ait#lsp#hover()
for i in range(20) | sleep 200m | if !empty(popup_list()) | break | endif | endfor
let pl = popup_list()
call add(out, 'hover_popups=' . len(pl))
if !empty(pl) | call add(out, 'hover_text=' . join(getbufline(winbufnr(pl[0]), 1, '$'), ' | ')) | endif
" ]d jumps to the next diagnostic
call cursor(1, 1)
call ait#lsp#jump(1)
call add(out, 'jump_line=' . line('.'))
call ait#lsp#stop()
call writefile(out, '__OUT__')
`);
  assert.match(r.out, /diag=\[[1-9]\d*, \d+\]/, `clangd reported the syntax error → error count > 0\n${r.out}`);
  assert.match(r.out, /items=[1-9]/);
  assert.match(r.out, /status=clangd/);
  assert.match(r.out, /def_line=2/, 'gd moved to the definition of add');
  assert.match(r.out, /hover_popups=1/, 'hover shows a popup');
  assert.match(r.out, /hover_text=.*add/i);
  assert.match(r.out, /jump_line=[45]/, ']d lands on the broken statement');
});

test('vim LSP: files without an installed server are left alone (no job, no errors)', { skip: !vimOk }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-txt-'));
  const file = path.join(dir, 'a.sh');
  fs.writeFileSync(file, 'echo hi\n');
  const r = runVim(`
set nocompatible encoding=utf-8
let &runtimepath = '__VIM__,' . &runtimepath
filetype plugin on
execute 'edit ${file}'
set filetype=sh
let $PATH = '/usr/bin:/bin'
call ait#lsp#attach()
call writefile(['status=[' . ait#lsp#status() . ']'], '__OUT__')
`);
  assert.match(r.out, /status=\[\]/);
});

const raBin = ['rust-analyzer', path.join(os.homedir(), '.cargo/bin/rust-analyzer')].find((c) => { try { return spawnSync(c, ['--version'], { timeout: 8000 }).status === 0; } catch { return false; } });
const raOk = !!raBin; // the rustup proxy exists even when the component is not installed: only a working binary counts
test('vim LSP (rust-analyzer): a syntax error in a real Cargo project is reported', { skip: !vimOk || !raOk || !has('cargo') && !fs.existsSync(path.join(os.homedir(), '.cargo/bin/cargo')), timeout: 240000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-rs-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n');
  fs.writeFileSync(path.join(dir, 'src', 'main.rs'), 'fn main() {\n    let x = ;\n    println!("{}", x);\n}\n');
  const r = runVim(`
set nocompatible encoding=utf-8
let &runtimepath = '__VIM__,' . &runtimepath
let $PATH = $PATH . ':${path.join(os.homedir(), '.cargo/bin')}'
filetype plugin on
execute 'edit ${path.join(dir, 'src', 'main.rs')}'
set filetype=rust
call ait#lsp#attach()
for i in range(240)
  sleep 250m
  if get(b:, 'ait_diag', [0, 0])[0] > 0 | break | endif
endfor
call writefile(['diag=' . string(get(b:, 'ait_diag', [])), 'status=' . ait#lsp#status(), 'msg=' . join(map(copy(get(b:, 'ait_lsp_items', [])), 'v:val.text'), ' | ')], '__OUT__')
call ait#lsp#stop()
`, 120000);
  assert.match(r.out, /diag=\[[1-9]/, r.out);
  assert.match(r.out, /status=rust-analyzer/);
});
