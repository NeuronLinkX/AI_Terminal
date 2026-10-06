# MacAIterm shell integration for fish (loaded with `fish --init-command 'source ...'`).
function __ait_b64
    printf '%s' $argv[1] | /usr/bin/base64 | /usr/bin/tr -d '\n'
end
function __ait_preexec --on-event fish_preexec
    printf '\e]777;ait;C;%s\a' (__ait_b64 "$argv[1]")
end
function __ait_postexec --on-event fish_postexec
    printf '\e]777;ait;D;%d;%s\a' $status (__ait_b64 "$PWD")
end
# first prompt of the session: report the initial cwd so the host knows the shell is ready
function __ait_ready --on-event fish_prompt
    functions -e __ait_ready
    printf '\e]777;ait;D;0;%s\a' (__ait_b64 "$PWD")
end
set -gx AIT_TERMINAL 1
