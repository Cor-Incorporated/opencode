#!/bin/sh
# guardrails.sh -- PreToolUse guardrails enforcement
# Exit 0 = pass, Exit 2 = block dangerous operations
#
# Environment variables (set by hook executor):
#   OPENCODE_TOOL_NAME  - name of the tool being invoked
#   OPENCODE_TOOL_INPUT - JSON string of tool arguments

TOOL="$OPENCODE_TOOL_NAME"
INPUT="$OPENCODE_TOOL_INPUT"

# Only check bash/shell tool invocations
case "$TOOL" in
  bash) ;;
  *) exit 0 ;;
esac

# Block destructive filesystem operations (rm -rf / or rm -rf /*)
if printf '%s\n' "$INPUT" | grep -qE 'rm\s+-rf\s+/[^a-zA-Z]|rm\s+-rf\s+/\s*$'; then
  printf 'GUARDRAIL BLOCKED: Destructive rm -rf / detected\n' >&2
  exit 2
fi

# Block disk formatting
if printf '%s\n' "$INPUT" | grep -qE 'mkfs\.|dd\s+if='; then
  printf 'GUARDRAIL BLOCKED: Disk formatting command detected\n' >&2
  exit 2
fi

# Block fork bombs
if printf '%s\n' "$INPUT" | grep -qE ':\(\)\{|\.fork\s*bomb'; then
  printf 'GUARDRAIL BLOCKED: Fork bomb pattern detected\n' >&2
  exit 2
fi

# Block database destruction
if printf '%s\n' "$INPUT" | grep -qiE 'DROP\s+(DATABASE|TABLE)\s'; then
  printf 'GUARDRAIL BLOCKED: Database destruction command detected\n' >&2
  exit 2
fi

# Warn on force operations (don't block, just context inject via stderr)
if printf '%s\n' "$INPUT" | grep -qE 'git\s+push\s+--force|git\s+reset\s+--hard'; then
  printf 'GUARDRAIL WARNING: Force operation detected -- proceed with caution\n' >&2
  exit 0
fi

exit 0
