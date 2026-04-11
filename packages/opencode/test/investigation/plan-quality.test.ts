import { describe, test, expect } from "bun:test"
import { PlanQuality } from "../../src/investigation/plan-quality"

describe("PlanQuality", () => {
  describe("score", () => {
    test("returns 100 for non-data-analysis tasks", () => {
      const result = PlanQuality.score("Refactor the user service to use dependency injection")
      expect(result.isDataAnalysisTask).toBe(false)
      expect(result.overall).toBe(100)
    })

    test("detects data analysis tasks by keywords", () => {
      const cases = [
        "Analyze usage statistics for the API",
        "Generate a traffic report for last month",
        "How many users accessed the endpoint",
        "Check gcloud logging for request counts",
        "Review analytics dashboard metrics",
      ]
      for (const text of cases) {
        const result = PlanQuality.score(text)
        expect(result.isDataAnalysisTask).toBe(true)
      }
    })

    test("scores 0 for data task with no checkpoints", () => {
      const result = PlanQuality.score("Generate a usage report showing request counts")
      expect(result.isDataAnalysisTask).toBe(true)
      expect(result.overall).toBe(0)
    })

    test("detects data source identification", () => {
      const result = PlanQuality.score(
        "Analyze usage metrics. Data sources: Cloud Run logs, SQL database, git history"
      )
      expect(result.hasDataSources).toBe(true)
    })

    test("detects test traffic evaluation", () => {
      const result = PlanQuality.score(
        "Check usage statistics. Exclude test traffic by filtering User-Agent patterns and internal IPs (RFC 1918)"
      )
      expect(result.hasTestTrafficEval).toBe(true)
    })

    test("detects error analysis", () => {
      const result = PlanQuality.score(
        "Review traffic report. Check error rates for 4xx and 5xx status codes"
      )
      expect(result.hasErrorAnalysis).toBe(true)
    })

    test("detects cross-reference verification", () => {
      const result = PlanQuality.score(
        "Analyze usage. Cross-reference traffic spikes with deployment history and git log"
      )
      expect(result.hasCrossReference).toBe(true)
    })

    test("detects statistical sanity checks", () => {
      const result = PlanQuality.score(
        "Report on usage statistics. Check for anomalies and statistical outliers in the distribution"
      )
      expect(result.hasStatisticalSanity).toBe(true)
    })

    test("scores 100 when all checkpoints present", () => {
      const plan = [
        "Analyze usage metrics for the API.",
        "Data sources: Cloud Run logs and SQL database.",
        "Filter out test traffic using User-Agent patterns.",
        "Check HTTP error rates for 4xx responses.",
        "Cross-reference with deployment history.",
        "Look for statistical anomalies in the data.",
      ].join("\n")

      const result = PlanQuality.score(plan)
      expect(result.isDataAnalysisTask).toBe(true)
      expect(result.overall).toBe(100)
      expect(result.hasDataSources).toBe(true)
      expect(result.hasTestTrafficEval).toBe(true)
      expect(result.hasErrorAnalysis).toBe(true)
      expect(result.hasCrossReference).toBe(true)
      expect(result.hasStatisticalSanity).toBe(true)
    })

    test("scores partial when some checkpoints missing", () => {
      const plan = [
        "Review traffic report.",
        "Data sources: gcloud logging.",
        "Check error analysis for broken endpoints.",
      ].join("\n")

      const result = PlanQuality.score(plan)
      expect(result.isDataAnalysisTask).toBe(true)
      expect(result.overall).toBe(40) // 2 out of 5
      expect(result.hasDataSources).toBe(true)
      expect(result.hasErrorAnalysis).toBe(true)
      expect(result.hasTestTrafficEval).toBe(false)
    })
  })

  describe("warning", () => {
    test("returns undefined for non-data tasks", () => {
      const score = PlanQuality.score("Refactor the auth module")
      expect(PlanQuality.warning(score)).toBeUndefined()
    })

    test("returns undefined when score >= 80", () => {
      const plan = [
        "Analyze usage metrics.",
        "Data sources: Cloud Run logs.",
        "Filter test traffic via User-Agent.",
        "Check 4xx error rates.",
        "Cross-reference with git log.",
        "Check for anomalies.",
      ].join("\n")
      const score = PlanQuality.score(plan)
      expect(PlanQuality.warning(score)).toBeUndefined()
    })

    test("returns warning with missing checkpoints when score < 80", () => {
      const score = PlanQuality.score("Generate a usage report")
      const msg = PlanQuality.warning(score)
      expect(msg).toBeDefined()
      expect(msg).toContain("Investigation quality: 0%")
      expect(msg).toContain("Data source identification")
      expect(msg).toContain("Test traffic evaluation")
    })

    test("lists only missing checkpoints", () => {
      const plan = [
        "Check traffic report.",
        "Data sources: SQL database.",
        "Filter bot traffic with User-Agent checks.",
      ].join("\n")
      const score = PlanQuality.score(plan)
      const msg = PlanQuality.warning(score)
      expect(msg).toBeDefined()
      expect(msg).not.toContain("Data source identification")
      expect(msg).not.toContain("Test traffic evaluation")
      expect(msg).toContain("Error analysis")
      expect(msg).toContain("Cross-reference")
    })
  })
})
