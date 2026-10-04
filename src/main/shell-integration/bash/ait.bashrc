# AI Terminal shell integration for bash (loaded with `bash --rcfile`).
# Same private OSC protocol as zsh:  command start (C) / command end + exit status + cwd (D).
[[ -r "$HOME/.bash_profile" ]] && source "$HOME/.bash_profile" || { [[ -r "$HOME/.bashrc" ]] && source "$HOME/.bashrc"; }
# bash keeps history in $HOME by default; make sure the app folder is never used.
export AIT_TERMINAL=1

__ait_b64() { printf '%s' "$1" | /usr/bin/base64 | /usr/bin/tr -d '\n'; }
__ait_in_prompt=1
__ait_preexec() {
  # runs for every simple command via the DEBUG trap; only report the first one of a command line
  [[ -n "$COMP_LINE" ]] && return
  [[ "$__ait_in_prompt" == "1" ]] || return
  [[ "$BASH_COMMAND" == __ait_* || "$BASH_COMMAND" == "$PROMPT_COMMAND" ]] && return
  __ait_in_prompt=0
  printf '\e]777;ait;C;%s\a' "$(__ait_b64 "$(HISTTIMEFORMAT= history 1 | sed 's/^ *[0-9]* *//')")"
}
__ait_precmd() {
  local __ec=$?
  printf '\e]777;ait;D;%d;%s\a' "$__ec" "$(__ait_b64 "$PWD")"
  __ait_in_prompt=1
  return $__ec
}
# Mac-style prompt unless the user's own rc set one:  user@host ~/path $
case "$PS1" in ''|'\s-\v\$ '|'bash-'*|'\h:\W \u\$ ') PS1='\[\e[32m\]\u@\h\[\e[0m\] \[\e[34m\]\w\[\e[0m\] \$ ';; esac
# AIT_PROMPT replaces the prompt outright (bash syntax), e.g. for screen recordings that must not show the account or host name.
[ -n "$AIT_PROMPT" ] && PS1="$AIT_PROMPT"
PROMPT_COMMAND="__ait_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
trap '__ait_preexec' DEBUG
