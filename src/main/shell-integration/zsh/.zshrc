# Load the user's real .zshrc first, then restore ZDOTDIR and install the hooks that report
# command start (C) and command end + exit status + cwd (D) to the host app via private OSC.
# macOS /etc/zshrc defaults HISTFILE to "$ZDOTDIR/.zsh_history" — which is this app folder. Keep the user's real history file.
if [[ -z "$HISTFILE" || "$HISTFILE" == "$ZDOTDIR/.zsh_history" ]]; then
  HISTFILE="${AIT_USER_ZDOTDIR:-$HOME}/.zsh_history"
fi
ZDOTDIR="${AIT_USER_ZDOTDIR:-$HOME}"
[[ -r "$ZDOTDIR/.zshrc" ]] && source "$ZDOTDIR/.zshrc"
if [[ -n "$AIT_USER_ZDOTDIR" ]]; then ZDOTDIR="$AIT_USER_ZDOTDIR"; else unset ZDOTDIR; fi

# Mac-style prompt: user@host ~/full/path %   (only replaces the stock zsh prompt; a prompt you customised
# in your own ~/.zshrc is kept. A stray Windows-looking prompt such as C:\dir> is also reset.)
# Opt out with AIT_KEEP_PROMPT=1.
if [[ -z "$AIT_KEEP_PROMPT" ]]; then
  if [[ -z "$PS1" || "$PS1" == '%n@%m %1~ %# ' || "$PS1" == '%m%# ' || "$PS1" == *'C:\\'* || "$PS1" == '%# ' ]]; then
    PS1='%F{green}%n@%m%f %F{blue}%~%f %# '
  fi
fi
# AIT_PROMPT replaces the prompt outright (zsh syntax) — e.g. AIT_PROMPT='%F{green}user@mac%f %F{blue}%~%f %# ' for screen
# recordings that must not show the account or host name.
[[ -n "$AIT_PROMPT" ]] && PS1="$AIT_PROMPT"

__ait_b64() { printf '%s' "$1" | /usr/bin/base64 | /usr/bin/tr -d '\n'; }
__ait_preexec() { printf '\e]777;ait;C;%s\a' "$(__ait_b64 "$1")"; }
__ait_precmd()  { local __ec=$?; printf '\e]777;ait;D;%d;%s\a' "$__ec" "$(__ait_b64 "$PWD")"; }
autoload -Uz add-zsh-hook
add-zsh-hook preexec __ait_preexec
precmd_functions=(__ait_precmd ${precmd_functions:#__ait_precmd})
export AIT_TERMINAL=1
