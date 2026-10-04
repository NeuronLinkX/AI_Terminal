__ait_zd="$ZDOTDIR"
ZDOTDIR="${AIT_USER_ZDOTDIR:-$HOME}"
[[ -r "$ZDOTDIR/.zprofile" ]] && source "$ZDOTDIR/.zprofile"
ZDOTDIR="$__ait_zd"
unset __ait_zd
