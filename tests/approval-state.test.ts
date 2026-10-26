import { ApprovalState } from "../src/approval-state";

describe("ApprovalState", () => {
  it("approves a single user when minimum is 1", async () => {
    const s = new ApprovalState(["u1", "u2"], 1);
    await expect(s.tryApprove("u1")).resolves.toBe("approved");
    expect(s.isComplete()).toBe(true);
    expect(s.getApprovers()).toEqual(["u1"]);
  });

  it("returns remaining when more approvals needed", async () => {
    const s = new ApprovalState(["u1", "u2"], 2);
    await expect(s.tryApprove("u1")).resolves.toBe("remaining");
    expect(s.isComplete()).toBe(false);
    await expect(s.tryApprove("u2")).resolves.toBe("approved");
    expect(s.isComplete()).toBe(true);
  });

  it("rejects unknown user as not-authorized", async () => {
    const s = new ApprovalState(["u1"], 1);
    await expect(s.tryApprove("intruder")).resolves.toBe("not-authorized");
    expect(s.isComplete()).toBe(false);
  });

  it("rejects double approval as already-approved", async () => {
    const s = new ApprovalState(["u1", "u2"], 2);
    await s.tryApprove("u1");
    await expect(s.tryApprove("u1")).resolves.toBe("already-approved");
    expect(s.getApprovers()).toEqual(["u1"]);
  });

  it("getRemaining returns currently-pending approvers", async () => {
    const s = new ApprovalState(["u1", "u2", "u3"], 2);
    await s.tryApprove("u2");
    expect(s.getRemaining().sort()).toEqual(["u1", "u3"]);
  });

  it("serializes concurrent approvals via mutex", async () => {
    const s = new ApprovalState(["u1", "u2", "u3"], 3);
    const results = await Promise.all([
      s.tryApprove("u1"),
      s.tryApprove("u2"),
      s.tryApprove("u3"),
    ]);
    expect(results.filter(r => r === "approved")).toHaveLength(1);
    expect(results.filter(r => r === "remaining")).toHaveLength(2);
    expect(s.getApprovers().sort()).toEqual(["u1", "u2", "u3"]);
  });

  it("records approval timestamps", async () => {
    const s = new ApprovalState(["u1"], 1);
    const before = Date.now();
    await s.tryApprove("u1");
    const records = s.getApprovalRecords();
    expect(records).toHaveLength(1);
    expect(records[0].user).toBe("u1");
    expect(records[0].ts).toBeGreaterThanOrEqual(before);
    expect(records[0].ts).toBeLessThanOrEqual(Date.now());
  });

  it("rejects: single reject completes when minimumRejects=1", async () => {
    const s = new ApprovalState(["u1", "u2"], 2);
    await expect(s.tryReject("u1")).resolves.toBe("rejected");
    expect(s.getRejecters()).toEqual(["u1"]);
  });

  it("rejects: returns remaining until minimumRejects met", async () => {
    const s = new ApprovalState(["u1", "u2", "u3"], 3, 2);
    await expect(s.tryReject("u1")).resolves.toBe("remaining");
    await expect(s.tryReject("u2")).resolves.toBe("rejected");
  });

  it("rejects: unknown user is not-authorized", async () => {
    const s = new ApprovalState(["u1"], 1);
    await expect(s.tryReject("intruder")).resolves.toBe("not-authorized");
  });

  it("rejects: double reject is already-rejected", async () => {
    const s = new ApprovalState(["u1"], 1, 2);
    await s.tryReject("u1");
    await expect(s.tryReject("u1")).resolves.toBe("already-rejected");
  });

  it("mutex survives a callback that returns a falsy value", async () => {
    const s = new ApprovalState(["u1", "u2"], 2);
    const r1 = s.tryApprove("u1");
    const r2 = s.tryApprove("u1");
    await expect(r1).resolves.toBe("remaining");
    await expect(r2).resolves.toBe("already-approved");
  });

  it("exposes minimumCount and minimumRejectCount", () => {
    const s = new ApprovalState(["u1"], 1, 3);
    expect(s.minimumCount).toBe(1);
    expect(s.minimumRejectCount).toBe(3);
  });

  it("closes on approval threshold: later votes return closed and are not recorded", async () => {
    const s = new ApprovalState(["u1", "u2"], 1);
    await expect(s.tryApprove("u1")).resolves.toBe("approved");
    expect(s.isClosed()).toBe(true);
    await expect(s.tryApprove("u2")).resolves.toBe("closed");
    await expect(s.tryReject("u2")).resolves.toBe("closed");
    expect(s.getApprovers()).toEqual(["u1"]);
    expect(s.getRejecters()).toEqual([]);
  });

  it("closes on reject threshold: later approvals are not recorded", async () => {
    const s = new ApprovalState(["u1", "u2"], 1);
    await expect(s.tryReject("u1")).resolves.toBe("rejected");
    expect(s.isClosed()).toBe(true);
    await expect(s.tryApprove("u2")).resolves.toBe("closed");
    expect(s.getApprovers()).toEqual([]);
  });

  it("stays open while votes are below both thresholds", async () => {
    const s = new ApprovalState(["u1", "u2", "u3"], 2, 2);
    await s.tryApprove("u1");
    await s.tryReject("u2");
    expect(s.isClosed()).toBe(false);
  });

  it("concurrent final approve and reject yield exactly one terminal result", async () => {
    const s = new ApprovalState(["u1", "u2"], 1);
    const results = await Promise.all([s.tryApprove("u1"), s.tryReject("u2")]);
    expect(results).toEqual(["approved", "closed"]);
    expect(s.getRejecters()).toEqual([]);
  });

  it("concurrent approvals past the threshold: one approved, the rest closed", async () => {
    const s = new ApprovalState(["u1", "u2", "u3"], 1);
    const results = await Promise.all([
      s.tryApprove("u1"),
      s.tryApprove("u2"),
      s.tryApprove("u3"),
    ]);
    expect(results).toEqual(["approved", "closed", "closed"]);
    expect(s.getApprovers()).toEqual(["u1"]);
  });

  it("close() claims the outcome exactly once and blocks later votes", async () => {
    const s = new ApprovalState(["u1"], 1);
    expect(s.close()).toBe(true);
    expect(s.close()).toBe(false);
    await expect(s.tryApprove("u1")).resolves.toBe("closed");
    expect(s.getApprovers()).toEqual([]);
  });

  it("rejecting after approving withdraws the approval", async () => {
    const s = new ApprovalState(["u1", "u2"], 2, 2);
    await expect(s.tryApprove("u1")).resolves.toBe("remaining");
    await expect(s.tryReject("u1")).resolves.toBe("remaining");
    expect(s.getApprovers()).toEqual([]);
    expect(s.getRejecters()).toEqual(["u1"]);
    await expect(s.tryApprove("u2")).resolves.toBe("remaining");
  });

  it("approving after rejecting withdraws the rejection", async () => {
    const s = new ApprovalState(["u1", "u2"], 2, 2);
    await s.tryReject("u1");
    await expect(s.tryApprove("u1")).resolves.toBe("remaining");
    expect(s.getRejecters()).toEqual([]);
    expect(s.getRejectionRecords()).toEqual([]);
    await expect(s.tryReject("u2")).resolves.toBe("remaining");
    await expect(s.tryApprove("u2")).resolves.toBe("approved");
  });

  it("a switched vote can reach the other threshold, leaving no stale approval", async () => {
    const s = new ApprovalState(["u1", "u2"], 2, 1);
    await s.tryApprove("u1");
    await expect(s.tryReject("u1")).resolves.toBe("rejected");
    expect(s.getApprovalRecords()).toEqual([]);
  });

  it("close() fails once a vote has decided the outcome", async () => {
    const s = new ApprovalState(["u1"], 1);
    await s.tryApprove("u1");
    expect(s.close()).toBe(false);
  });
});
