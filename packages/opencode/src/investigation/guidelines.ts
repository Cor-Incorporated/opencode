import { Log } from "@/util/log"

const log = Log.create({ service: "investigation.guidelines" })

export namespace InvestigationGuidelines {
  export interface CloudLogContext {
    provider: "gcloud" | "aws" | "azure"
    command: string
    hasUserAgentFilter: boolean
    hasStatusFilter: boolean
    hasIpFilter: boolean
  }

  // Detection patterns for cloud log commands
  const PATTERNS: Array<{ provider: CloudLogContext["provider"]; regex: RegExp }> = [
    { provider: "gcloud", regex: /gcloud\s+logging\s+(read|tail)/ },
    { provider: "aws", regex: /aws\s+(logs\s+(filter-log-events|get-log-events|start-query)|cloudwatch\s+get-metric)/ },
    { provider: "azure", regex: /az\s+(monitor\s+(log-analytics|metrics)|log-analytics)/ },
  ]

  /**
   * Detect if a bash command involves cloud log analysis.
   * Returns context about the command, or undefined if not a cloud log command.
   */
  export function detect(toolInput: string): CloudLogContext | undefined {
    for (const { provider, regex } of PATTERNS) {
      if (regex.test(toolInput)) {
        return {
          provider,
          command: toolInput.slice(0, 200), // truncate for context
          hasUserAgentFilter: /userAgent|user_agent|user-agent/i.test(toolInput),
          hasStatusFilter: /status[>=<!]|httpRequest\.status|statusCode/i.test(toolInput),
          hasIpFilter: /remoteIp|remote_ip|sourceIp|source_ip|clientIp/i.test(toolInput),
        }
      }
    }
    return undefined
  }

  /**
   * Generate investigation guidelines based on detected cloud log context.
   * These are injected as <hook-context> to guide the model's analysis.
   */
  export function getGuidelines(ctx: CloudLogContext): string {
    const missing: string[] = []
    if (!ctx.hasUserAgentFilter) {
      missing.push("- Extract httpRequest.userAgent to classify traffic sources (developer vs real user vs bot)")
    }
    if (!ctx.hasIpFilter) {
      missing.push("- Extract httpRequest.remoteIp to identify developer/CI IP ranges (RFC 1918: 10.x, 172.16-31.x, 192.168.x)")
    }
    if (!ctx.hasStatusFilter) {
      missing.push("- Filter by httpRequest.status >= 400 to identify error patterns and broken endpoints")
    }

    const lines = [
      `[Investigation Guidelines — ${ctx.provider} log analysis detected]`,
      "",
      "REQUIRED before reporting usage numbers:",
    ]

    if (missing.length > 0) {
      lines.push("Missing filters in this query:")
      lines.push(...missing)
      lines.push("")
    }

    lines.push(
      "Checklist:",
      "1. Traffic source classification: separate developer/bot/CI traffic from real users",
      "2. Error analysis: check 4xx/5xx rates and identify broken endpoints",
      "3. Cross-reference: correlate traffic patterns with git log --since/--until for deployment activity",
      "4. Anomaly detection: flag impossible values (future dates, 2026-era iOS 14, suspicious uniformity)",
      "5. NEVER report raw request counts as 'real user traffic' without traffic source validation",
    )

    return lines.join("\n")
  }
}
