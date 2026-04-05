#!/bin/sh
# enforce-factcheck-before-edit.sh
# PreToolUse hook: warns when Write/Edit tools are invoked without evidence of prior research
# Exit 0 = pass (advisory only), stderr message becomes hook context

TOOL="$OPENCODE_TOOL_NAME"
INPUT="$OPENCODE_TOOL_INPUT"

# Only apply to write/edit tools
case "$TOOL" in
  write|Write|edit|Edit) ;;
  *) exit 0 ;;
esac

# Check if tool input contains evidence of prior file reading
if echo "$INPUT" | grep -qiE '(based on reading|as shown in|from the file|grep result|read tool output|line [0-9]+)'; then
  echo "FACT-CHECK: Evidence of prior research detected" >&2
  exit 0
fi

echo "FACT-CHECK WARNING: File edit attempted without evidence of reading the target file first. Best practice: read the file before editing." >&2
exit 0
