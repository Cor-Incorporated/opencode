import { describe, test, expect } from "bun:test"
import { InvestigationGuidelines } from "../../src/investigation/guidelines"

describe("InvestigationGuidelines", () => {
  describe("detect", () => {
    test("detects gcloud logging read command", () => {
      const ctx = InvestigationGuidelines.detect('gcloud logging read "resource.type=cloud_run_revision"')
      expect(ctx).toBeDefined()
      expect(ctx!.provider).toBe("gcloud")
    })

    test("detects gcloud logging tail command", () => {
      const ctx = InvestigationGuidelines.detect("gcloud logging tail")
      expect(ctx).toBeDefined()
      expect(ctx!.provider).toBe("gcloud")
    })

    test("detects aws logs filter-log-events", () => {
      const ctx = InvestigationGuidelines.detect('aws logs filter-log-events --log-group-name /ecs/api')
      expect(ctx).toBeDefined()
      expect(ctx!.provider).toBe("aws")
    })

    test("detects aws logs get-log-events", () => {
      const ctx = InvestigationGuidelines.detect("aws logs get-log-events --log-group my-group")
      expect(ctx).toBeDefined()
      expect(ctx!.provider).toBe("aws")
    })

    test("detects aws cloudwatch get-metric", () => {
      const ctx = InvestigationGuidelines.detect("aws cloudwatch get-metric-statistics --namespace AWS/ELB")
      expect(ctx).toBeDefined()
      expect(ctx!.provider).toBe("aws")
    })

    test("detects az monitor log-analytics", () => {
      const ctx = InvestigationGuidelines.detect("az monitor log-analytics query -w workspace-id")
      expect(ctx).toBeDefined()
      expect(ctx!.provider).toBe("azure")
    })

    test("returns undefined for non-cloud commands", () => {
      expect(InvestigationGuidelines.detect("ls -la")).toBeUndefined()
      expect(InvestigationGuidelines.detect("git log --oneline")).toBeUndefined()
      expect(InvestigationGuidelines.detect("npm install")).toBeUndefined()
      expect(InvestigationGuidelines.detect("echo hello")).toBeUndefined()
    })

    test("detects existing userAgent filter", () => {
      const ctx = InvestigationGuidelines.detect('gcloud logging read "httpRequest.userAgent=Chrome"')
      expect(ctx).toBeDefined()
      expect(ctx!.hasUserAgentFilter).toBe(true)
    })

    test("detects missing userAgent filter", () => {
      const ctx = InvestigationGuidelines.detect('gcloud logging read "resource.type=cloud_run_revision"')
      expect(ctx).toBeDefined()
      expect(ctx!.hasUserAgentFilter).toBe(false)
    })

    test("detects existing status filter", () => {
      const ctx = InvestigationGuidelines.detect('gcloud logging read "httpRequest.status>=400"')
      expect(ctx).toBeDefined()
      expect(ctx!.hasStatusFilter).toBe(true)
    })

    test("detects existing IP filter", () => {
      const ctx = InvestigationGuidelines.detect('gcloud logging read "httpRequest.remoteIp=10.0.0.1"')
      expect(ctx).toBeDefined()
      expect(ctx!.hasIpFilter).toBe(true)
    })

    test("truncates long commands in context", () => {
      const longCmd = "gcloud logging read " + "a".repeat(300)
      const ctx = InvestigationGuidelines.detect(longCmd)
      expect(ctx).toBeDefined()
      expect(ctx!.command.length).toBeLessThanOrEqual(200)
    })
  })

  describe("getGuidelines", () => {
    test("includes missing filter warnings when filters absent", () => {
      const ctx: InvestigationGuidelines.CloudLogContext = {
        provider: "gcloud",
        command: "gcloud logging read",
        hasUserAgentFilter: false,
        hasStatusFilter: false,
        hasIpFilter: false,
      }
      const guidelines = InvestigationGuidelines.getGuidelines(ctx)
      expect(guidelines).toContain("userAgent")
      expect(guidelines).toContain("remoteIp")
      expect(guidelines).toContain("status >= 400")
      expect(guidelines).toContain("Missing filters")
    })

    test("omits filter warnings when filters present", () => {
      const ctx: InvestigationGuidelines.CloudLogContext = {
        provider: "aws",
        command: "aws logs filter-log-events",
        hasUserAgentFilter: true,
        hasStatusFilter: true,
        hasIpFilter: true,
      }
      const guidelines = InvestigationGuidelines.getGuidelines(ctx)
      expect(guidelines).not.toContain("Missing filters")
    })

    test("includes provider name", () => {
      const ctx: InvestigationGuidelines.CloudLogContext = {
        provider: "azure",
        command: "az monitor",
        hasUserAgentFilter: false,
        hasStatusFilter: false,
        hasIpFilter: false,
      }
      const guidelines = InvestigationGuidelines.getGuidelines(ctx)
      expect(guidelines).toContain("azure")
    })

    test("includes mandatory checklist items", () => {
      const ctx: InvestigationGuidelines.CloudLogContext = {
        provider: "gcloud",
        command: "gcloud logging read",
        hasUserAgentFilter: true,
        hasStatusFilter: true,
        hasIpFilter: true,
      }
      const guidelines = InvestigationGuidelines.getGuidelines(ctx)
      expect(guidelines).toContain("Traffic source classification")
      expect(guidelines).toContain("Error analysis")
      expect(guidelines).toContain("Cross-reference")
      expect(guidelines).toContain("Anomaly detection")
      expect(guidelines).toContain("NEVER report raw request counts")
    })
  })
})
