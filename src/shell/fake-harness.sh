#!/bin/sh
# TEST-ONLY stand-in for a harness CLI (claude-code or omp stream format). Behaviour is driven by env, see attempt-fixture.ts:
#   FORMAT    claude-code | omp: which stream lines to print
#   LAUNCHES  file that gets one line per start (proves nobody launched twice)
#   STARTED   file that receives this shell's pid once running (and STARTED.pwd the working directory)
#   PRE       shell snippet evaluated in the working directory (edit files, forge control files, background a child ...)
#   WAIT_FOR  poll until this path exists
#   OUT_SRC   copied to $ARK_OUT/output.json
#   EXIT      exit status (default 0)
case "$FORMAT" in
  claude-code) echo '{"type":"system","subtype":"init","session_id":"s1","model":"scripted-model"}' ;;
  omp) echo '{"type":"session","id":"s1"}' ;;
esac
[ -n "$LAUNCHES" ] && echo $$ >> "$LAUNCHES"
if [ -n "$STARTED" ]; then
  pwd > "$STARTED.pwd"
  echo $$ > "$STARTED.tmp" && mv "$STARTED.tmp" "$STARTED"
fi
[ -n "$PRE" ] && eval "$PRE"
if [ -n "$WAIT_FOR" ]; then
  while [ ! -e "$WAIT_FOR" ]; do sleep 0.05; done
fi
[ -n "$OUT_SRC" ] && cp "$OUT_SRC" "$ARK_OUT/output.json"
case "$FORMAT" in
  claude-code)
    echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write"}]}}'
    echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.25,"usage":{"input_tokens":3,"output_tokens":7}}' ;;
  omp)
    echo '{"type":"tool_execution_start","toolName":"write"}'
    echo '{"type":"message_end","message":{"role":"assistant","model":"scripted-model","usage":{"input":3,"output":7,"cost":{"total":0.25}}}}'
    echo '{"type":"agent_end","messages":[{"role":"assistant","stopReason":"stop"}]}' ;;
esac
exit "${EXIT:-0}"
