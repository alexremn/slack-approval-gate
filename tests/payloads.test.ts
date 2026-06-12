import {
  hasPayload,
  readGithubContext,
  defaultMainPayload,
  renderApprovalReply,
  renderFinalStatus,
  substituteTemplateVars,
  escapeMrkdwn,
} from "../src/payloads";

describe("hasPayload", () => {
  it("returns false for undefined", () => {
    expect(hasPayload(undefined)).toBe(false);
  });
  it("returns false for empty object", () => {
    expect(hasPayload({})).toBe(false);
  });
  it("returns true when text is non-empty", () => {
    expect(hasPayload({ text: "hi" })).toBe(true);
  });
  it("returns false when text is empty string", () => {
    expect(hasPayload({ text: "" })).toBe(false);
  });
  it("returns true when blocks is non-empty array", () => {
    expect(hasPayload({ blocks: [{ type: "section" }] })).toBe(true);
  });
  it("returns false when blocks is empty array", () => {
    expect(hasPayload({ blocks: [] })).toBe(false);
  });
});

describe("readGithubContext", () => {
  it("reads expected env vars with empty fallback", () => {
    const orig = { ...process.env };
    process.env.GITHUB_SERVER_URL = "https://github.com";
    process.env.GITHUB_REPOSITORY = "owner/repo";
    process.env.GITHUB_RUN_ID = "42";
    process.env.GITHUB_REF_NAME = "feature/x";
    process.env.GITHUB_SHA = "deadbeef";
    delete process.env.GITHUB_ACTOR;
    const ctx = readGithubContext();
    expect(ctx.serverUrl).toBe("https://github.com");
    expect(ctx.repo).toBe("owner/repo");
    expect(ctx.runId).toBe("42");
    expect(ctx.actor).toBe("");
    expect(ctx.refName).toBe("feature/x");
    expect(ctx.sha).toBe("deadbeef");
    process.env = orig;
  });
});

describe("defaultMainPayload", () => {
  const baseCtx = {
    serverUrl: "https://github.com",
    repo: "owner/repo",
    runId: "42",
    runNumber: "7",
    runAttempt: "1",
    workflow: "ci",
    runnerOs: "Linux",
    actor: "alice",
    refName: "main",
    sha: "abcdef1234567890",
  };

  it("returns header + fields with hyperlinked context", () => {
    const p = defaultMainPayload(baseCtx);
    expect(p.text).toContain("ci");
    expect(p.text).toContain("owner/repo");
    expect(Array.isArray(p.blocks)).toBe(true);
    expect((p.blocks![0] as any).type).toBe("header");
    expect((p.blocks![0] as any).text.text).toContain("Approval required");
    const fields = (p.blocks![1] as any).fields as Array<{ text: string }>;
    expect(
      fields.some(f =>
        f.text.includes("<https://github.com/owner/repo|owner/repo>"),
      ),
    ).toBe(true);
    expect(
      fields.some(f =>
        f.text.includes("<https://github.com/owner/repo/actions/runs/42|ci #7>"),
      ),
    ).toBe(true);
    expect(
      fields.some(f =>
        f.text.includes("<https://github.com/alice|alice>"),
      ),
    ).toBe(true);
    expect(
      fields.some(f =>
        f.text.includes("<https://github.com/owner/repo/tree/main|main>"),
      ),
    ).toBe(true);
    expect(
      fields.some(f =>
        f.text.includes("<https://github.com/owner/repo/commit/abcdef1234567890|abcdef1>"),
      ),
    ).toBe(true);
  });

  it("adds attempt suffix when runAttempt > 1", () => {
    const p = defaultMainPayload({ ...baseCtx, runAttempt: "2" });
    const fields = (p.blocks![1] as any).fields as Array<{ text: string }>;
    expect(fields.some(f => f.text.includes("ci #7 (attempt 2)"))).toBe(true);
  });

  it("escapes mrkdwn-significant chars in actor and branch", () => {
    const p = defaultMainPayload({
      ...baseCtx,
      actor: "bot<dev>",
      refName: "feature/<x>",
    });
    const text = JSON.stringify(p.blocks);
    expect(text).toContain("bot&lt;dev&gt;");
    expect(text).toContain("feature/&lt;x&gt;");
  });

  it("uses a Unicode header so all Slack clients render it", () => {
    const p = defaultMainPayload(baseCtx);
    expect((p.blocks![0] as any).text.text).toContain("🔒");
  });

  it("omits branch and commit fields when env missing", () => {
    const p = defaultMainPayload({ ...baseCtx, refName: "", sha: "" });
    const fields = (p.blocks![1] as any).fields as Array<{ text: string }>;
    expect(fields.some(f => f.text.startsWith("*Branch*"))).toBe(false);
    expect(fields.some(f => f.text.startsWith("*Commit*"))).toBe(false);
  });
});

describe("renderApprovalReply", () => {
  it("renders title + actions blocks with action ids", () => {
    const blocks = renderApprovalReply({
      minimumCount: 2,
      remaining: ["u1", "u2"],
      approved: [],
      approveActionId: "approve-id",
      rejectActionId: "reject-id",
    });
    expect(blocks).toHaveLength(2);
    expect((blocks[0] as any).type).toBe("section");
    expect((blocks[0] as any).text.text).toContain("Required approvals:* 2");
    expect((blocks[0] as any).text.text).toContain("Still needed:* 2");
    expect((blocks[0] as any).text.text).toContain("<@u1>");
    const actions = blocks[1] as any;
    expect(actions.type).toBe("actions");
    expect(actions.elements[0].value).toBe("approve-id");
    expect(actions.elements[0].action_id).toBe("slack-approval-approve");
    expect(actions.elements[1].value).toBe("reject-id");
    expect(actions.elements[1].action_id).toBe("slack-approval-reject");
  });

  it("shows current approvers and decremented still-needed", () => {
    const blocks = renderApprovalReply({
      minimumCount: 2,
      remaining: ["u2"],
      approved: ["u1"],
      approveActionId: "a",
      rejectActionId: "r",
    });
    const text = (blocks[0] as any).text.text;
    expect(text).toContain("Still needed:* 1");
    expect(text).toContain("Approved by:* <@u1>");
  });
});

describe("escapeMrkdwn", () => {
  it("escapes &, <, >", () => {
    expect(escapeMrkdwn("a&b<c>d")).toBe("a&amp;b&lt;c&gt;d");
  });
});

describe("substituteTemplateVars", () => {
  const vars = { approvers: ["u1", "u2"], rejecters: ["u9"] };

  it("replaces {{approvers}} in text with mention list", () => {
    const out = substituteTemplateVars({ text: "Approved by {{approvers}}" }, vars);
    expect(out.text).toBe("Approved by <@u1>, <@u2>");
  });

  it("replaces {{rejecters}} inside blocks", () => {
    const out = substituteTemplateVars(
      { blocks: [{ type: "section", text: { type: "mrkdwn", text: "Denied by {{rejecters}}" } }] },
      vars,
    );
    expect((out.blocks![0] as any).text.text).toBe("Denied by <@u9>");
  });

  it("tolerates whitespace inside braces and multiple occurrences", () => {
    const out = substituteTemplateVars(
      { text: "{{ approvers }} / {{approvers}}" },
      vars,
    );
    expect(out.text).toBe("<@u1>, <@u2> / <@u1>, <@u2>");
  });

  it("replaces with empty string when list is empty", () => {
    const out = substituteTemplateVars(
      { text: "by {{rejecters}}" },
      { approvers: [], rejecters: [] },
    );
    expect(out.text).toBe("by ");
  });

  it("leaves payloads without tokens untouched", () => {
    const payload = { text: "plain", blocks: [{ type: "section" }] };
    expect(substituteTemplateVars(payload, vars)).toEqual(payload);
  });

  it("does not mutate the input payload", () => {
    const payload = { text: "by {{approvers}}" };
    substituteTemplateVars(payload, vars);
    expect(payload.text).toBe("by {{approvers}}");
  });
});

describe("renderFinalStatus", () => {
  it("renders approved status with approver list", () => {
    const blocks = renderFinalStatus("approved", ["u1", "u2"]);
    expect((blocks[0] as any).text.text).toContain("Approved");
    expect((blocks[0] as any).text.text).toContain("<@u1>");
  });
  it("renders rejected with rejectedBy", () => {
    const blocks = renderFinalStatus("rejected", [], "u9");
    expect((blocks[0] as any).text.text).toContain("Rejected by <@u9>");
  });
  it("renders canceled", () => {
    expect((renderFinalStatus("canceled", [])[0] as any).text.text).toContain("Canceled");
  });
  it("renders timed-out", () => {
    expect((renderFinalStatus("timed-out", [])[0] as any).text.text).toContain("Timed out");
  });
});
