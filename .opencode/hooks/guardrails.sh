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

# --- CRITICAL-1/2: Block rm with recursive+force on root paths ---
# Allowlist approach: block ANY rm -rf / pattern, then allow safe exceptions.
# Catches combined flags (-rf, -fr), separated flags (-r -f), and long flags (--recursive --force).
# NOTE (HIGH-1): This may produce false positives on string literals containing these
# patterns (e.g. grep patterns, documentation). This is intentional -- the guardrail
# prioritizes safety over convenience. Users can restructure commands to avoid matches.
SAFE_RM='(/tmp|/var/tmp)(/|$|\s)'
# Check combined flags: -rf, -fr, and variants with extra flags
if printf '%s\n' "$INPUT" | grep -qE 'rm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|--recursive)\s+/'; then
  if ! printf '%s\n' "$INPUT" | grep -qE "rm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|--recursive)\s+${SAFE_RM}"; then
    printf 'GUARDRAIL BLOCKED: Destructive rm -rf on root path detected\n' >&2
    exit 2
  fi
fi
# Check separated flags: rm -r -f / or rm -f -r /
if printf '%s\n' "$INPUT" | grep -qE 'rm\s+.*-r.*-f.*\s+/' || printf '%s\n' "$INPUT" | grep -qE 'rm\s+.*-f.*-r.*\s+/'; then
  if ! printf '%s\n' "$INPUT" | grep -qE "rm\s+.*-[rf].*-[rf].*\s+${SAFE_RM}"; then
    printf 'GUARDRAIL BLOCKED: Destructive rm -rf on root path detected\n' >&2
    exit 2
  fi
fi

# Block disk formatting and writes to block devices
if printf '%s\n' "$INPUT" | grep -qE 'mkfs\.|dd\s+.*of=/dev/'; then
  printf 'GUARDRAIL BLOCKED: Disk formatting command detected\n' >&2
  exit 2
fi

# Block fork bombs (CRITICAL-3: space-tolerant regex)
if printf '%s\n' "$INPUT" | grep -qE ':\(\)\s*\{|\.fork\s*bomb'; then
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
