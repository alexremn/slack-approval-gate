import { registerHandlers, type HandlersDeps } from "../src/handlers";
import { ApprovalState } from "../src/approval-state";
import { SlackClient } from "../src/slack-client";

type ActionFn = (args: any) => Promise<void>;

function makeApp() {
  const actions: Record<string, ActionFn> = {};
  return {
    action: jest.fn((id: string, fn: ActionFn) => {
      actions[id] = fn;
    }),
    actions,
  };
}

function makeSlack(): jest.Mocked<SlackClient> {
  return {
    postMain: jest.fn(),
    postApprovalReply: jest.fn(),
    updateApprovalReply: jest.fn().mockResolvedValue(undefined),
    postEphemeral: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<SlackClient>;
}

function makeBoltArgs(userId: string, value: string) {
  return {
    ack: jest.fn().mockResolvedValue(undefined),
    body: { user: { id: userId } },
    action: { type: "button", value },
    logger: { error: jest.fn(), info: jest.fn() },
  };
}

function makeDeps(over: Partial<HandlersDeps> = {}): { app: ReturnType<typeof makeApp>; deps: HandlersDeps; onTerminal: jest.Mock } {
  const app = makeApp();
  const slack = makeSlack();
  const state = new ApprovalState(["u1", "u2"], 2);
  const onTerminal = jest.fn().mockResolvedValue(undefined);
  const deps: HandlersDeps = {
    app: app as any,
    slack,
    state,
    approvalMessageTs: "2.0",
    approveActionId: "approve-id",
    rejectActionId: "reject-id",
    successPayload: {},
    failPayload: {},
    onTerminal,
    ...over,
  };
  return { app, deps, onTerminal };
}

describe("registerHandlers", () => {
  it("registers approve and reject action ids", () => {
    const { app, deps } = makeDeps();
    registerHandlers(deps);
    expect(app.action).toHaveBeenCalledWith("slack-approval-approve", expect.any(Function));
    expect(app.action).toHaveBeenCalledWith("slack-approval-reject", expect.any(Function));
  });

  it("approve: not-authorized user gets ephemeral, no state mutation", async () => {
    const { app, deps } = makeDeps();
    registerHandlers(deps);
    await app.actions["slack-approval-approve"](makeBoltArgs("intruder", "approve-id"));
    expect((deps.slack as jest.Mocked<SlackClient>).postEphemeral).toHaveBeenCalledWith(
      "intruder", expect.stringMatching(/not authorized/i), "2.0",
    );
    expect((deps.slack as jest.Mocked<SlackClient>).updateApprovalReply).not.toHaveBeenCalled();
    expect(deps.onTerminal).not.toHaveBeenCalled();
  });

  it("approve: already-approved user gets ephemeral on second click", async () => {
    const { app, deps } = makeDeps();
    registerHandlers(deps);
    await app.actions["slack-approval-approve"](makeBoltArgs("u1", "approve-id"));
    (deps.slack as jest.Mocked<SlackClient>).updateApprovalReply.mockClear();
    (deps.slack as jest.Mocked<SlackClient>).postEphemeral.mockClear();
    await app.actions["slack-approval-approve"](makeBoltArgs("u1", "approve-id"));
    expect((deps.slack as jest.Mocked<SlackClient>).postEphemeral).toHaveBeenCalledWith(
      "u1", expect.stringMatching(/already approved/i), "2.0",
    );
    expect((deps.slack as jest.Mocked<SlackClient>).updateApprovalReply).not.toHaveBeenCalled();
    expect(deps.onTerminal).not.toHaveBeenCalled();
  });

  it("approve: remaining → updates reply, no terminal", async () => {
    const { app, deps } = makeDeps();
    registerHandlers(deps);
    await app.actions["slack-approval-approve"](makeBoltArgs("u1", "approve-id"));
    expect((deps.slack as jest.Mocked<SlackClient>).updateApprovalReply).toHaveBeenCalled();
    expect(deps.onTerminal).not.toHaveBeenCalled();
  });

  it("approve: approved → updates reply with default success block + terminal('approved')", async () => {
    const { app, deps, onTerminal } = makeDeps({
      state: new ApprovalState(["u1"], 1),
    });
    registerHandlers(deps);
    await app.actions["slack-approval-approve"](makeBoltArgs("u1", "approve-id"));
    expect((deps.slack as jest.Mocked<SlackClient>).updateApprovalReply).toHaveBeenCalled();
    expect(onTerminal).toHaveBeenCalledWith("approved");
  });

  it("approve: approved with custom successPayload uses that payload", async () => {
    const { app, deps } = makeDeps({
      state: new ApprovalState(["u1"], 1),
      successPayload: { text: "ok" },
    });
    registerHandlers(deps);
    await app.actions["slack-approval-approve"](makeBoltArgs("u1", "approve-id"));
    const upd = (deps.slack as jest.Mocked<SlackClient>).updateApprovalReply;
    expect(upd).toHaveBeenCalledWith("2.0", expect.objectContaining({ text: "ok" }));
  });

  it("approve: action.value mismatch is ignored", async () => {
    const { app, deps } = makeDeps();
    registerHandlers(deps);
    await app.actions["slack-approval-approve"](makeBoltArgs("u1", "WRONG"));
    expect((deps.slack as jest.Mocked<SlackClient>).updateApprovalReply).not.toHaveBeenCalled();
    expect(deps.onTerminal).not.toHaveBeenCalled();
  });

  it("reject: updates reply with default rejected block + terminal('rejected', userId)", async () => {
    const { app, deps, onTerminal } = makeDeps();
    registerHandlers(deps);
    await app.actions["slack-approval-reject"](makeBoltArgs("u1", "reject-id"));
    expect((deps.slack as jest.Mocked<SlackClient>).updateApprovalReply).toHaveBeenCalled();
    expect(onTerminal).toHaveBeenCalledWith("rejected", "u1");
  });

  it("reject: unauthorized user gets ephemeral and no terminal", async () => {
    const { app, deps, onTerminal } = makeDeps();
    registerHandlers(deps);
    await app.actions["slack-approval-reject"](makeBoltArgs("intruder", "reject-id"));
    expect((deps.slack as jest.Mocked<SlackClient>).postEphemeral).toHaveBeenCalledWith(
      "intruder",
      expect.stringMatching(/not authorized/i),
      "2.0",
    );
    expect(onTerminal).not.toHaveBeenCalled();
  });

  it("reject: quorum > 1 requires multiple rejects", async () => {
    const { app, deps, onTerminal } = makeDeps({
      state: new ApprovalState(["u1", "u2"], 2, 2),
    });
    registerHandlers(deps);
    await app.actions["slack-approval-reject"](makeBoltArgs("u1", "reject-id"));
    expect(onTerminal).not.toHaveBeenCalled();
    await app.actions["slack-approval-reject"](makeBoltArgs("u2", "reject-id"));
    expect(onTerminal).toHaveBeenCalledWith("rejected", "u2");
  });

  it("reject: custom failPayload is used", async () => {
    const { app, deps } = makeDeps({ failPayload: { text: "no" } });
    registerHandlers(deps);
    await app.actions["slack-approval-reject"](makeBoltArgs("u1", "reject-id"));
    const upd = (deps.slack as jest.Mocked<SlackClient>).updateApprovalReply;
    expect(upd).toHaveBeenCalledWith("2.0", expect.objectContaining({ text: "no" }));
  });

  it("approve: self-approval blocked when configured", async () => {
    const { app, deps, onTerminal } = makeDeps({
      state: new ApprovalState(["u1"], 1),
      preventSelfApproval: true,
      selfApprovalSlackId: "u1",
    });
    registerHandlers(deps);
    await app.actions["slack-approval-approve"](makeBoltArgs("u1", "approve-id"));
    expect((deps.slack as jest.Mocked<SlackClient>).postEphemeral).toHaveBeenCalledWith(
      "u1",
      expect.stringMatching(/self-approval is disabled/i),
      "2.0",
    );
    expect(onTerminal).not.toHaveBeenCalled();
  });

  it("approve: terminal update failure does not block onTerminal", async () => {
    const { app, deps, onTerminal } = makeDeps({
      state: new ApprovalState(["u1"], 1),
    });
    (deps.slack as jest.Mocked<SlackClient>).updateApprovalReply.mockRejectedValueOnce(
      new Error("slack down"),
    );
    registerHandlers(deps);
    await app.actions["slack-approval-approve"](makeBoltArgs("u1", "approve-id"));
    expect(onTerminal).toHaveBeenCalledWith("approved");
  });

  it("approve: ignores second press after terminal", async () => {
    const { app, deps, onTerminal } = makeDeps({
      state: new ApprovalState(["u1", "u2"], 1),
    });
    registerHandlers(deps);
    await app.actions["slack-approval-approve"](makeBoltArgs("u1", "approve-id"));
    expect(onTerminal).toHaveBeenCalledTimes(1);
    (deps.slack as jest.Mocked<SlackClient>).updateApprovalReply.mockClear();
    await app.actions["slack-approval-approve"](makeBoltArgs("u2", "approve-id"));
    expect((deps.slack as jest.Mocked<SlackClient>).updateApprovalReply).not.toHaveBeenCalled();
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });

  it("baseBlocks: approve remaining update prepends base blocks", async () => {
    const baseBlocks = [{ type: "section", text: { type: "mrkdwn", text: "BASE" } }];
    const { app, deps } = makeDeps({ baseBlocks, baseText: "base txt" });
    registerHandlers(deps);
    await app.actions["slack-approval-approve"](makeBoltArgs("u1", "approve-id"));
    const upd = (deps.slack as jest.Mocked<SlackClient>).updateApprovalReply;
    expect(upd).toHaveBeenCalledTimes(1);
    const [, payload] = upd.mock.calls[0];
    expect(payload.text).toBe("base txt");
    expect((payload.blocks as any[])[0]).toEqual(baseBlocks[0]);
    expect((payload.blocks as any[]).length).toBeGreaterThan(1);
  });

  it("baseBlocks: terminal approval update keeps base blocks", async () => {
    const baseBlocks = [{ type: "header", text: { type: "plain_text", text: "B" } }];
    const { app, deps } = makeDeps({
      state: new ApprovalState(["u1"], 1),
      baseBlocks,
    });
    registerHandlers(deps);
    await app.actions["slack-approval-approve"](makeBoltArgs("u1", "approve-id"));
    const upd = (deps.slack as jest.Mocked<SlackClient>).updateApprovalReply;
    const [, payload] = upd.mock.calls[0];
    expect((payload.blocks as any[])[0]).toEqual(baseBlocks[0]);
  });

  it("baseBlocks: reject terminal with custom failPayload replaces message without base blocks", async () => {
    const baseBlocks = [{ type: "section", text: { type: "mrkdwn", text: "B" } }];
    const { app, deps } = makeDeps({
      baseBlocks,
      failPayload: { text: "no", blocks: [{ type: "section", text: { type: "mrkdwn", text: "X" } }] },
    });
    registerHandlers(deps);
    await app.actions["slack-approval-reject"](makeBoltArgs("u1", "reject-id"));
    const upd = (deps.slack as jest.Mocked<SlackClient>).updateApprovalReply;
    const [, payload] = upd.mock.calls[0];
    expect(payload.text).toBe("no");
    expect(payload.blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "X" } },
    ]);
  });

  it("baseBlocks: approve terminal with custom successPayload replaces message without base blocks", async () => {
    const baseBlocks = [{ type: "header", text: { type: "plain_text", text: "B" } }];
    const { app, deps } = makeDeps({
      state: new ApprovalState(["u1"], 1),
      baseBlocks,
      successPayload: { text: "ok", blocks: [{ type: "section", text: { type: "mrkdwn", text: "Y" } }] },
    });
    registerHandlers(deps);
    await app.actions["slack-approval-approve"](makeBoltArgs("u1", "approve-id"));
    const upd = (deps.slack as jest.Mocked<SlackClient>).updateApprovalReply;
    const [, payload] = upd.mock.calls[0];
    expect(payload.text).toBe("ok");
    expect(payload.blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "Y" } },
    ]);
  });

  it("approve: custom successPayload substitutes {{approvers}} with mentions", async () => {
    const { app, deps } = makeDeps({
      state: new ApprovalState(["u1"], 1),
      successPayload: {
        text: "Approved by {{approvers}}",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "✅ {{approvers}}" } }],
      },
    });
    registerHandlers(deps);
    await app.actions["slack-approval-approve"](makeBoltArgs("u1", "approve-id"));
    const upd = (deps.slack as jest.Mocked<SlackClient>).updateApprovalReply;
    const [, payload] = upd.mock.calls[0];
    expect(payload.text).toBe("Approved by <@u1>");
    expect((payload.blocks as any[])[0].text.text).toBe("✅ <@u1>");
  });

  it("reject: custom failPayload substitutes {{rejecters}} with mentions", async () => {
    const { app, deps } = makeDeps({
      failPayload: { text: "Denied by {{rejecters}}" },
    });
    registerHandlers(deps);
    await app.actions["slack-approval-reject"](makeBoltArgs("u2", "reject-id"));
    const upd = (deps.slack as jest.Mocked<SlackClient>).updateApprovalReply;
    const [, payload] = upd.mock.calls[0];
    expect(payload.text).toBe("Denied by <@u2>");
  });

  it("reject: action.value mismatch is ignored", async () => {
    const { app, deps, onTerminal } = makeDeps();
    registerHandlers(deps);
    await app.actions["slack-approval-reject"](makeBoltArgs("u9", "WRONG"));
    expect((deps.slack as jest.Mocked<SlackClient>).updateApprovalReply).not.toHaveBeenCalled();
    expect(deps.onTerminal).not.toHaveBeenCalled();
  });
});
