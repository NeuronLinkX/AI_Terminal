# MacAIterm shell integration (proxy): load the user's own .zshenv, keep ZDOTDIR pointing here
# so that .zprofile/.zshrc proxies below are also read.
__ait_zd="$ZDOTDIR"
ZDOTDIR="${AIT_USER_ZDOTDIR:-$HOME}"
[[ -r "$ZDOTDIR/.zshenv" ]] && source "$ZDOTDIR/.zshenv"
ZDOTDIR="$__ait_zd"
unset __ait_zd
