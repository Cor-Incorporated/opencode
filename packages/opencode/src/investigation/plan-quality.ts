import { Log } from "@/util/log"

const log = Log.create({ service: "investigation.plan-quality" })

export namespace PlanQuality {
  export interface Score {
    overall: number // 0-100
    hasDataSources: boolean
    hasTestTrafficEval: boolean
    hasErrorAnalysis: boolean
    hasCrossReference: boolean
    hasStatisticalSanity: boolean
    isDataAnalysisTask: boolean
  }

  // Keywords that indicate this is a data analysis task
  const DATA_ANALYSIS_INDICATORS = [
    /usage|utilization|traffic/i,
    /analytics|metrics|statistics/i,
    /how many|how much|count/i,
    /report|summary|findings/i,
    /gcloud|aws|cloudwatch|datadog/i,
    /log analysis|log review/i,
    /requests?\s+(per|count|volume)/i,
    /conversion|retention|engagement/i,
  ]

  // Checkpoint keywords (case-insensitive)
  const CHECKPOINT_PATTERNS: Array<{ key: keyof Omit<Score, "overall" | "isDataAnalysisTask">; patterns: RegExp[] }> = [
    {
      key: "hasDataSources",
      patterns: [
        /data source/i,
        /cloud log|cloud run|cloudwatch/i,
        /database|sql|query/i,
        /git (log|history|blame)/i,
        /metrics|dashboard/i,
      ],
    },
    {
      key: "hasTestTrafficEval",
      patterns: [
        /test traffic|bot traffic|developer traffic/i,
        /user.?agent/i,
        /internal ip|private ip|rfc.?1918/i,
        /curl|postman|automation/i,
        /real user|genuine user|actual user/i,
      ],
    },
    {
      key: "hasErrorAnalysis",
      patterns: [
        /error (rate|analysis|check)/i,
        /4[0-9]{2}|5[0-9]{2}/,
        /http.*(error|status|code)/i,
        /broken.*(endpoint|route|url)/i,
      ],
    },
    {
      key: "hasCrossReference",
      patterns: [
        /cross.?reference|cross.?check/i,
        /correlat(e|ion)/i,
        /independent.*(source|verification)/i,
        /deploy.*(history|log|timeline)/i,
        /git log.*traffic|traffic.*git log/i,
      ],
    },
    {
      key: "hasStatisticalSanity",
      patterns: [
        /anomal(y|ies|ous)/i,
        /statistical|outlier/i,
        /sanity.?check/i,
        /unusual|suspicious|impossible/i,
        /distribution|skew|bias/i,
      ],
    },
  ]

  /**
   * Score a plan's investigation quality.
   * Returns 0-100 based on how many investigation checkpoints are addressed.
   */
  export function score(planContent: string): Score {
    const isDataAnalysisTask = DATA_ANALYSIS_INDICATORS.some((p) => p.test(planContent))

    const result: Score = {
      overall: 100,
      hasDataSources: false,
      hasTestTrafficEval: false,
      hasErrorAnalysis: false,
      hasCrossReference: false,
      hasStatisticalSanity: false,
      isDataAnalysisTask,
    }

    if (!isDataAnalysisTask) {
      return result // Non-data tasks get full marks
    }

    for (const checkpoint of CHECKPOINT_PATTERNS) {
      result[checkpoint.key] = checkpoint.patterns.some((p) => p.test(planContent))
    }

    const checkpoints = [
      result.hasDataSources,
      result.hasTestTrafficEval,
      result.hasErrorAnalysis,
      result.hasCrossReference,
      result.hasStatisticalSanity,
    ]
    const passed = checkpoints.filter(Boolean).length
    result.overall = Math.round((passed / checkpoints.length) * 100)

    return result
  }

  /**
   * Generate a warning message if investigation quality is insufficient.
   */
  export function warning(planScore: Score): string | undefined {
    if (!planScore.isDataAnalysisTask) return undefined
    if (planScore.overall >= 80) return undefined

    const missing: string[] = []
    if (!planScore.hasDataSources) missing.push("Data source identification")
    if (!planScore.hasTestTrafficEval) missing.push("Test traffic evaluation")
    if (!planScore.hasErrorAnalysis) missing.push("Error analysis (4xx/5xx)")
    if (!planScore.hasCrossReference) missing.push("Cross-reference verification")
    if (!planScore.hasStatisticalSanity) missing.push("Statistical sanity check")

    return [
      `Investigation quality: ${planScore.overall}% (minimum 80% recommended for data analysis tasks)`,
      "",
      "Missing investigation checkpoints:",
      ...missing.map((m) => `  - ${m}`),
      "",
      "Consider addressing these before proceeding to implementation.",
    ].join("\n")
  }
}
