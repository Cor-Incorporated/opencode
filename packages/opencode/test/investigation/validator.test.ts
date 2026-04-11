import { describe, test, expect } from "bun:test"
import { InvestigationValidator } from "../../src/investigation/validator"

describe("InvestigationValidator", () => {
  describe("validate", () => {
    test("detects curl User-Agent", () => {
      const result = InvestigationValidator.validate('userAgent: "curl/7.88.1"')
      expect(result.testTrafficIndicators.length).toBeGreaterThan(0)
      expect(result.warnings.length).toBeGreaterThan(0)
    })

    test("detects python-requests User-Agent", () => {
      const result = InvestigationValidator.validate('User-Agent: python-requests/2.31.0')
      expect(result.testTrafficIndicators.length).toBeGreaterThan(0)
    })

    test("detects HeadlessChrome", () => {
      const result = InvestigationValidator.validate("HeadlessChrome/120.0")
      expect(result.testTrafficIndicators.length).toBeGreaterThan(0)
    })

    test("detects Postman agent", () => {
      const result = InvestigationValidator.validate("User-Agent: PostmanRuntime/7.32")
      expect(result.testTrafficIndicators.length).toBeGreaterThan(0)
    })

    test("detects RFC 1918 private IPs (10.x)", () => {
      const result = InvestigationValidator.validate("remoteIp: 10.0.1.25")
      expect(result.internalIpCount).toBe(1)
      expect(result.warnings.length).toBeGreaterThan(0)
    })

    test("detects RFC 1918 private IPs (172.16-31.x)", () => {
      const result = InvestigationValidator.validate("remoteIp: 172.16.0.1")
      expect(result.internalIpCount).toBe(1)
    })

    test("detects RFC 1918 private IPs (192.168.x)", () => {
      const result = InvestigationValidator.validate("remoteIp: 192.168.1.100")
      expect(result.internalIpCount).toBe(1)
    })

    test("detects localhost", () => {
      const result = InvestigationValidator.validate("remoteIp: 127.0.0.1")
      expect(result.internalIpCount).toBe(1)
    })

    test("counts multiple internal IPs", () => {
      const result = InvestigationValidator.validate(
        "10.0.0.1 made request, 10.0.0.2 made request, 192.168.1.1 made request"
      )
      expect(result.internalIpCount).toBe(3)
    })

    test("detects HTTP error status codes", () => {
      const result = InvestigationValidator.validate("status: 404\nstatus: 500\nstatus: 200")
      expect(result.errorStatusCount).toBe(2) // 404 and 500
    })

    test("detects suspicious old iOS User-Agent", () => {
      const result = InvestigationValidator.validate("Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X)")
      expect(result.warnings.some(w => w.includes("iOS"))).toBe(true)
    })

    test("returns clean result for normal traffic", () => {
      const result = InvestigationValidator.validate("200 OK - Chrome/120 - 203.0.113.1")
      expect(result.testTrafficIndicators.length).toBe(0)
      expect(result.internalIpCount).toBe(0)
      expect(result.suggestions.length).toBeGreaterThan(0) // "verify independently" suggestion
    })

    test("handles empty output", () => {
      const result = InvestigationValidator.validate("")
      expect(result.warnings.length).toBe(0)
      expect(result.testTrafficIndicators.length).toBe(0)
    })
  })

  describe("formatMessage", () => {
    test("returns undefined when no warnings or suggestions", () => {
      const result = InvestigationValidator.formatMessage({
        warnings: [],
        suggestions: [],
        testTrafficIndicators: [],
        internalIpCount: 0,
        errorStatusCount: 0,
      })
      expect(result).toBeUndefined()
    })

    test("formats warnings with ! prefix", () => {
      const msg = InvestigationValidator.formatMessage({
        warnings: ["Test traffic detected"],
        suggestions: [],
        testTrafficIndicators: ["curl: 5"],
        internalIpCount: 0,
        errorStatusCount: 0,
      })
      expect(msg).toBeDefined()
      expect(msg).toContain("WARNINGS:")
      expect(msg).toContain("! Test traffic detected")
    })

    test("formats suggestions with > prefix", () => {
      const msg = InvestigationValidator.formatMessage({
        warnings: [],
        suggestions: ["Check error rates"],
        testTrafficIndicators: [],
        internalIpCount: 0,
        errorStatusCount: 5,
      })
      expect(msg).toBeDefined()
      expect(msg).toContain("SUGGESTIONS:")
      expect(msg).toContain("> Check error rates")
    })

    test("includes Data Quality Validation header", () => {
      const msg = InvestigationValidator.formatMessage({
        warnings: ["issue"],
        suggestions: [],
        testTrafficIndicators: [],
        internalIpCount: 0,
        errorStatusCount: 0,
      })
      expect(msg).toContain("[Data Quality Validation]")
    })
  })
})
