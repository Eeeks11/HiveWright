import { describe, expect, it } from "vitest";
import { classifyGitHubIssueCloseout, classifyGitHubIssueCloseouts } from "@/closeout/github-state";

describe("GitHub issue closeout state classifier", () => {
  it("keeps open related issues in backlog even when PR prose claims progress", () => {
    const result = classifyGitHubIssueCloseout({
      owner: "Eeeks11",
      repo: "HiveWright",
      number: 44,
      state: "OPEN",
      title: "Related closeout drift backlog item",
      labels: ["assistant-pr-opened"],
      linkedPullRequests: [
        {
          number: 57,
          state: "MERGED",
          mergeCommitOid: "6af0af0bf5cf9b3ad02107734991ce2fe2782b2c",
        },
      ],
      evidence: {
        unresolvedFindingKeys: ["github-issue-44-remains-open"],
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        issueRef: "Eeeks11/HiveWright#44",
        classification: "backlog_open",
        finalDispositionLabel: "github_issue_backlog_open",
        canAutoClose: false,
        confidence: "high",
      }),
    );
    expect(result.reasons.join(" ")).toContain("unresolved finding keys");
  });

  it("flags a closed issue with no landed commit evidence as stale or drifted", () => {
    const result = classifyGitHubIssueCloseout({
      owner: "Eeeks11",
      repo: "HiveWright",
      number: 45,
      state: "closed",
      title: "Closed without verifiable landed state",
      labels: ["closed-by-comment"],
    });

    expect(result).toEqual(
      expect.objectContaining({
        issueRef: "Eeeks11/HiveWright#45",
        classification: "stale_or_drifted",
        finalDispositionLabel: "github_issue_stale_or_drifted",
        canAutoClose: false,
        confidence: "high",
        relatedCommitOids: [],
      }),
    );
    expect(result.reasons).toEqual(["closed issue has no linked landed commit evidence"]);
  });

  it("flags closed landed issues when runtime/deploy verification does not include the landed commit", () => {
    const result = classifyGitHubIssueCloseout({
      owner: "Eeeks11",
      repo: "HiveWright",
      number: 55,
      state: "CLOSED",
      linkedPullRequests: [
        {
          number: 65,
          state: "MERGED",
          headRefOid: "4b525c90d183325c8ccbf2fc44e9605116ee71cb",
          mergeCommitOid: "57079a7ba88278f7ec12c588ff86f07904344fe5",
        },
      ],
      evidence: {
        runtimeVerifiedCommitOids: ["18cacfaa6b8682bde5802e7b2b53f63470f63d3e"],
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        classification: "stale_or_drifted",
        finalDispositionLabel: "github_issue_stale_or_drifted",
        canAutoClose: false,
        relatedCommitOids: expect.arrayContaining([
          "57079a7ba88278f7ec12c588ff86f07904344fe5",
          "4b525c90d183325c8ccbf2fc44e9605116ee71cb",
        ]),
      }),
    );
    expect(result.reasons).toEqual([
      "closed issue has landed commits, but none are verified by deployed/runtime evidence",
    ]);
  });

  it("classifies a closed issue as landed verified only with corroborating deployed/runtime evidence", () => {
    const result = classifyGitHubIssueCloseout({
      owner: "Eeeks11",
      repo: "HiveWright",
      number: 55,
      state: "CLOSED",
      linkedPullRequests: [
        {
          number: 65,
          state: "MERGED",
          mergeCommitOid: "57079a7ba88278f7ec12c588ff86f07904344fe5",
        },
      ],
      evidence: {
        deployedCommitOids: ["57079a7ba88278f7ec12c588ff86f07904344fe5"],
      },
    });

    expect(result).toEqual({
      issueRef: "Eeeks11/HiveWright#55",
      classification: "landed_verified",
      finalDispositionLabel: "github_issue_landed_verified",
      canAutoClose: true,
      confidence: "high",
      reasons: ["closed issue has landed commit evidence that matches deployed/runtime verification"],
      relatedCommitOids: ["57079a7ba88278f7ec12c588ff86f07904344fe5"],
    });
  });

  it("classifies batches without mutating GitHub state", () => {
    const results = classifyGitHubIssueCloseouts([
      {
        owner: "Eeeks11",
        repo: "HiveWright",
        number: 44,
        state: "OPEN",
      },
      {
        owner: "Eeeks11",
        repo: "HiveWright",
        number: 45,
        state: "CLOSED",
      },
    ]);

    expect(results.map((result) => result.finalDispositionLabel)).toEqual([
      "github_issue_backlog_open",
      "github_issue_stale_or_drifted",
    ]);
  });
});
