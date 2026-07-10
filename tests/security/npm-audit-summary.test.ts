import { describe, expect, it } from "vitest";
import { summarizeNpmAuditReport } from "@/security/npm-audit-summary";

type AuditFixture = {
  metadata: { vulnerabilities: { info: number; low: number; moderate: number; high: number; critical: number; total: number } };
  vulnerabilities: Record<string, unknown>;
};

const reviewedNodemailerAudit: AuditFixture = {
  metadata: {
    vulnerabilities: {
      info: 0,
      low: 1,
      moderate: 4,
      high: 1,
      critical: 0,
      total: 6,
    },
  },
  vulnerabilities: {
    nodemailer: {
      name: "nodemailer",
      severity: "high",
      isDirect: true,
      via: [
        {
          source: 1121191,
          name: "nodemailer",
          dependency: "nodemailer",
          title: "Nodemailer: Message-level raw option bypasses disableFileAccess/disableUrlAccess",
          url: "https://github.com/advisories/GHSA-p6gq-j5cr-w38f",
          severity: "high",
          range: "<=9.0.0",
        },
      ],
      effects: ["@auth/core", "next-auth"],
      range: "<=9.0.0",
      nodes: ["node_modules/nodemailer"],
      fixAvailable: {
        name: "next-auth",
        version: "1.12.1",
        isSemVerMajor: true,
      },
    },
  },
};

describe("npm audit summary", () => {
  it("keeps the exact reviewed Nodemailer/Auth.js mitigation out of blocking high counts", () => {
    const summary = summarizeNpmAuditReport(reviewedNodemailerAudit);

    expect(summary.rawCounts.high).toBe(1);
    expect(summary.counts.high).toBe(0);
    expect(summary.blockingFindingDetails).toEqual([]);
    expect(summary.reviewedFindingDetails).toHaveLength(1);
    expect(summary.reviewedFindingDetails[0]).toContain("GHSA-p6gq-j5cr-w38f");
    expect(summary.countDetail).toContain("1 high/critical finding(s) have exact reviewed mitigations");
  });

  it("does not allow the Nodemailer mitigation to hide a changed advisory shape", () => {
    const changedAudit = structuredClone(reviewedNodemailerAudit);
    (changedAudit.vulnerabilities.nodemailer as { nodes: string[] }).nodes = ["node_modules/other/nodemailer"];

    const summary = summarizeNpmAuditReport(changedAudit);

    expect(summary.counts.high).toBe(1);
    expect(summary.blockingFindingDetails).toEqual([
      "nodemailer: Nodemailer: Message-level raw option bypasses disableFileAccess/disableUrlAccess (GHSA-p6gq-j5cr-w38f)",
    ]);
    expect(summary.reviewedFindingDetails).toEqual([]);
  });

  it("continues to block unrelated high advisories", () => {
    const unrelatedAudit = structuredClone(reviewedNodemailerAudit);
    unrelatedAudit.metadata.vulnerabilities.high = 2;
    unrelatedAudit.vulnerabilities.ws = {
      name: "ws",
      severity: "high",
      via: [
        {
          title: "ws denial of service",
          url: "https://github.com/advisories/GHSA-xxxx-yyyy-zzzz",
          severity: "high",
          range: "<8.21.0",
        },
      ],
      effects: [],
      nodes: ["node_modules/ws"],
    };

    const summary = summarizeNpmAuditReport(unrelatedAudit);

    expect(summary.counts.high).toBe(1);
    expect(summary.blockingFindingDetails).toEqual(["ws: ws denial of service (GHSA-xxxx-yyyy-zzzz)"]);
    expect(summary.reviewedFindingDetails).toHaveLength(1);
  });
});
