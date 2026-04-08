type Text = {
  kind: "text"
  text: string
}

type Tool = {
  kind: "tool"
  name: string
  input: Record<string, unknown>
}

type Step = Text | Tool

export type Replay = {
  name: string
  command: string
  args: string
  mode: "primary" | "subtask"
  agent: string
  model: string
  models: string[]
  prompt: string[]
  guard?: string[]
  state?: Record<string, unknown>
  result: string
  steps: Step[]
}

export const replays = {
  implement: {
    name: "implement command",
    command: "implement",
    args: "Keep the change bounded to one file.",
    mode: "primary",
    agent: "implement",
    model: "openai/gpt-5-mini",
    models: ["gpt-5-mini"],
    prompt: [
      "Implement the requested change under the guardrail profile.",
      "keep the scope bounded to the stated goal",
      "run the smallest relevant verification before claiming completion",
    ],
    result: "Implemented the requested change in a bounded way.",
    steps: [{ kind: "text", text: "Implemented the requested change in a bounded way." }],
  },
  review: {
    name: "review command",
    command: "review",
    args: "Focus on the current diff only.",
    mode: "subtask",
    agent: "review",
    model: "openai/gpt-5-mini",
    models: ["gpt-5-mini", "gpt-5-mini"],
    prompt: [
      "Review the current work for correctness, regressions, missing tests, and missing workflow gates.",
      "Required sections:",
      "Findings",
      "Recommended next step",
    ],
    guard: [
      "Guardrail runtime state:",
      "unique source reads: 4",
      "fact-check: stale after 1 edit(s) since DocRead at 2026-04-03T09:00:00.000Z",
      "review state: stale after 1 edit(s) since 2026-04-03T09:10:00.000Z",
    ],
    state: {
      read_count: 4,
      edit_count: 2,
      factchecked: true,
      factcheck_source: "DocRead",
      factcheck_at: "2026-04-03T09:00:00.000Z",
      edit_count_since_check: 1,
      reviewed: true,
      review_at: "2026-04-03T09:10:00.000Z",
      edits_since_review: 1,
      last_block: "edit",
      last_reason: "context budget exceeded",
    },
    result: "Findings\n- none\nVerification\n- reviewed current diff\nOpen risks\n- none\nRecommended next step\n- ship if checks stay green",
    steps: [
      {
        kind: "tool",
        name: "task",
        input: {
          description: "review current work",
          prompt: "Review the current work for correctness, regressions, missing tests, and missing workflow gates.",
          subagent_type: "review",
          command: "review",
        },
      },
      {
        kind: "text",
        text: "Findings\n- none\nVerification\n- reviewed current diff\nOpen risks\n- none\nRecommended next step\n- ship if checks stay green",
      },
    ],
  },
  ship: {
    name: "ship command",
    command: "ship",
    args: "Check the current work only.",
    mode: "subtask",
    agent: "ship",
    model: "openai/gpt-5-mini",
    models: ["gpt-5-mini", "gpt-5-mini"],
    prompt: [
      "Execute the ship workflow for the current work:",
      "Identify the current PR",
      "Verify all gates",
      "gh pr merge",
    ],
    guard: [
      "Guardrail runtime state:",
      "unique source reads: 4",
      "fact-check: stale after 1 edit(s) since DocRead at 2026-04-03T09:00:00.000Z",
      "review state: stale after 1 edit(s) since 2026-04-03T09:10:00.000Z",
    ],
    state: {
      read_count: 4,
      edit_count: 2,
      factchecked: true,
      factcheck_source: "DocRead",
      factcheck_at: "2026-04-03T09:00:00.000Z",
      edit_count_since_check: 1,
      reviewed: true,
      review_at: "2026-04-03T09:10:00.000Z",
      edits_since_review: 1,
      last_block: "edit",
      last_reason: "context budget exceeded",
    },
    result: "Ready or Not ready\n- Not ready\nEvidence\n- local scenario replay only\nBlocking gates\n- full package checks not cited here\nNext action\n- run the narrowest required verification",
    steps: [
      {
        kind: "tool",
        name: "task",
        input: {
          description: "ship current work",
          prompt: "Execute the ship workflow for the current work:",
          subagent_type: "ship",
          command: "ship",
        },
      },
      {
        kind: "text",
        text: "Ready or Not ready\n- Not ready\nEvidence\n- local scenario replay only\nBlocking gates\n- full package checks not cited here\nNext action\n- run the narrowest required verification",
      },
    ],
  },
  handoff: {
    name: "handoff command",
    command: "handoff",
    args: "Summarize the current work.",
    mode: "subtask",
    agent: "review",
    model: "openai/gpt-5-mini",
    models: ["gpt-5-mini", "gpt-5-mini"],
    prompt: [
      "Prepare a handoff for the current work.",
      "Goal",
      "Guardrail state",
      "Next steps",
    ],
    guard: [
      "Guardrail runtime state:",
      "unique source reads: 4",
      "fact-check: stale after 1 edit(s) since DocRead at 2026-04-03T09:00:00.000Z",
      "review state: stale after 1 edit(s) since 2026-04-03T09:10:00.000Z",
    ],
    state: {
      read_count: 4,
      edit_count: 2,
      factchecked: true,
      factcheck_source: "DocRead",
      factcheck_at: "2026-04-03T09:00:00.000Z",
      edit_count_since_check: 1,
      reviewed: true,
      review_at: "2026-04-03T09:10:00.000Z",
      edits_since_review: 1,
      last_block: "edit",
      last_reason: "context budget exceeded",
    },
    result: "Goal\n- summarize guarded work\nConstraints\n- keep release gates explicit\nGuardrail state\n- enforced mode\nFiles changed\n- none in replay\nVerification\n- scenario replay only\nOpen risks\n- follow-up checks still required\nNext steps\n- continue from the cited guardrail state",
    steps: [
      {
        kind: "tool",
        name: "task",
        input: {
          description: "prepare handoff",
          prompt: "Prepare a handoff for the current work.",
          subagent_type: "review",
          command: "handoff",
        },
      },
      {
        kind: "text",
        text: "Goal\n- summarize guarded work\nConstraints\n- keep release gates explicit\nGuardrail state\n- enforced mode\nFiles changed\n- none in replay\nVerification\n- scenario replay only\nOpen risks\n- follow-up checks still required\nNext steps\n- continue from the cited guardrail state",
      },
    ],
  },
  "provider-eval": {
    name: "provider-eval command",
    command: "provider-eval",
    args: "Assess the isolated evaluation lane.",
    mode: "subtask",
    agent: "provider-eval",
    model: "openai/gpt-5.4-mini",
    models: ["gpt-5.4-mini", "openai/gpt-5.4-mini"],
    prompt: [
      "Evaluate the requested provider or model candidate using the dedicated provider-eval lane.",
      "Candidate",
      "Routing and data-policy notes",
      "Follow-up config change",
    ],
    result:
      "Candidate\n- openrouter/openai/gpt-5.4-mini\nEvidence\n- routed through provider-eval\nRouting and data-policy notes\n- keep OpenRouter isolated from the default lane\nRecommendation\n- retain evaluation-only admission\nFollow-up config change\n- none",
    steps: [
      {
        kind: "tool",
        name: "task",
        input: {
          description: "evaluate provider candidate",
          prompt: "Evaluate the requested provider or model candidate using the dedicated provider-eval lane.",
          subagent_type: "provider-eval",
          command: "provider-eval",
        },
      },
      {
        kind: "text",
        text:
          "Candidate\n- openrouter/openai/gpt-5.4-mini\nEvidence\n- routed through provider-eval\nRouting and data-policy notes\n- keep OpenRouter isolated from the default lane\nRecommendation\n- retain evaluation-only admission\nFollow-up config change\n- none",
      },
    ],
  },
} satisfies Record<string, Replay>
