import { Log } from "@/util/log"

const log = Log.create({ service: "investigation.validator" })

export namespace InvestigationValidator {
  export interface ValidationResult {
    warnings: string[]
    suggestions: string[]
    testTrafficIndicators: string[]
    internalIpCount: number
    errorStatusCount: number
  }

  // Known bot/automation User-Agent patterns
  const BOT_UA_PATTERNS = [
    /curl\//i,
    /python-requests\//i,
    /Go-http-client/i,
    /HeadlessChrome/i,
    /bot\b/i,
    /crawler/i,
    /spider/i,
    /wget\//i,
    /httpie\//i,
    /postman/i,
    /insomnia/i,
    /axios\//i,
    /node-fetch/i,
    /undici/i,
  ]

  // RFC 1918 private IP ranges
  const INTERNAL_IP_PATTERNS = [
    /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
    /\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/,
    /\b192\.168\.\d{1,3}\.\d{1,3}\b/,
    /\b127\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
    /\blocalhost\b/i,
    /\b::1\b/,
  ]

  // HTTP error status patterns
  const ERROR_STATUS_PATTERN = /\b[45]\d{2}\b/g

  /**
   * Validate cloud log output for data quality issues.
   * Returns warnings and indicators of test/internal traffic.
   */
  export function validate(output: string): ValidationResult {
    const warnings: string[] = []
    const suggestions: string[] = []
    const testTrafficIndicators: string[] = []
    let internalIpCount = 0
    let errorStatusCount = 0

    // Check for bot User-Agent patterns
    for (const pattern of BOT_UA_PATTERNS) {
      const matches = output.match(new RegExp(pattern.source, "gi"))
      if (matches && matches.length > 0) {
        testTrafficIndicators.push(`${pattern.source}: ${matches.length} occurrence(s)`)
      }
    }

    // Check for internal IPs
    for (const pattern of INTERNAL_IP_PATTERNS) {
      const matches = output.match(new RegExp(pattern.source, "g"))
      if (matches) {
        internalIpCount += matches.length
      }
    }

    // Check for HTTP error statuses
    const statusMatches = output.match(ERROR_STATUS_PATTERN)
    if (statusMatches) {
      errorStatusCount = statusMatches.length
    }

    // Generate warnings
    if (testTrafficIndicators.length > 0) {
      warnings.push(
        `Test/bot traffic detected: ${testTrafficIndicators.length} automation User-Agent pattern(s) found. ` +
        "These requests should be excluded from real user traffic counts."
      )
    }

    if (internalIpCount > 0) {
      warnings.push(
        `Internal/developer IPs detected: ${internalIpCount} private IP address(es) found (RFC 1918). ` +
        "These likely represent developer or CI traffic."
      )
    }

    if (errorStatusCount > 0) {
      suggestions.push(
        `HTTP error statuses found: ${errorStatusCount} 4xx/5xx response(s) detected. ` +
        "Investigate error patterns before reporting success rates."
      )
    }

    // Check for suspicious patterns
    if (/(?:iPhone OS|iOS)[_ ]14[._]/i.test(output) || /(?:iPhone OS|iOS)[_ ]13[._]/i.test(output)) {
      warnings.push(
        "Suspicious User-Agent: very old iOS version detected (iOS 13/14). " +
        "In 2026, this likely indicates a spoofed or test User-Agent."
      )
    }

    if (warnings.length === 0 && testTrafficIndicators.length === 0 && internalIpCount === 0) {
      suggestions.push("No obvious test traffic indicators found, but verify traffic sources independently.")
    }

    return { warnings, suggestions, testTrafficIndicators, internalIpCount, errorStatusCount }
  }

  /**
   * Format validation result as a hook context message.
   */
  export function formatMessage(result: ValidationResult): string | undefined {
    if (result.warnings.length === 0 && result.suggestions.length === 0) return undefined

    const lines = ["[Data Quality Validation]", ""]

    if (result.warnings.length > 0) {
      lines.push("WARNINGS:")
      for (const w of result.warnings) {
        lines.push(`  ! ${w}`)
      }
      lines.push("")
    }

    if (result.suggestions.length > 0) {
      lines.push("SUGGESTIONS:")
      for (const s of result.suggestions) {
        lines.push(`  > ${s}`)
      }
    }

    return lines.join("\n")
  }
}
