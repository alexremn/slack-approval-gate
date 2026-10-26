import { loadConfig } from "../src/config";

const INPUT_PREFIX = "INPUT_";
const APPROVER_A = "U01ABCDEF12";
const APPROVER_B = "U02ABCDEF34";
const APPROVER_C = "U03ABCDEF56";
const CHANNEL = "C0123ABCDE";

function setInput(name: string, value: string): void {
  process.env[`${INPUT_PREFIX}${name.toUpperCase()}`] = value;
}

function clearInputs(): void {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith(INPUT_PREFIX)) delete process.env[k];
  }
}

describe("loadConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    clearInputs();
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_APP_TOKEN = "xapp-test";
    process.env.SLACK_SIGNING_SECRET = "secret";
    process.env.SLACK_CHANNEL_ID = CHANNEL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("loads minimal valid config", () => {
    setInput("approvers", `${APPROVER_A},${APPROVER_B}`);
    const c = loadConfig();
    expect(c.approvers).toEqual([APPROVER_A, APPROVER_B]);
    expect(c.minimumApprovalCount).toBe(1);
    expect(c.minimumRejectCount).toBe(1);
    expect(c.preventSelfApproval).toBe(false);
    expect(c.baseMessageTs).toBeNull();
    expect(c.channelId).toBe(CHANNEL);
    expect(c.timeoutMs).toBe(30 * 60_000);
  });

  it("uses channel-id input over env", () => {
    setInput("approvers", APPROVER_A);
    setInput("channel-id", "C9999ABCDE");
    expect(loadConfig().channelId).toBe("C9999ABCDE");
  });

  it("rejects malformed channel-id", () => {
    setInput("approvers", APPROVER_A);
    setInput("channel-id", "#release");
    expect(() => loadConfig()).toThrow(/channel-id .* not a valid/);
  });

  it("rejects malformed approver id", () => {
    setInput("approvers", "u1");
    expect(() => loadConfig()).toThrow(/approvers entry "u1" is not a valid/);
  });

  it("normalizes approvers (trim, dedupe, drop empty)", () => {
    setInput("approvers", ` ${APPROVER_A} , ${APPROVER_B},, ${APPROVER_A} ,${APPROVER_C} `);
    expect(loadConfig().approvers).toEqual([APPROVER_A, APPROVER_B, APPROVER_C]);
  });

  it("throws when approvers list is empty after normalization", () => {
    setInput("approvers", " , , ");
    expect(() => loadConfig()).toThrow(/approvers/);
  });

  it("throws when minimum-approval-count exceeds approvers length", () => {
    setInput("approvers", APPROVER_A);
    setInput("minimum-approval-count", "2");
    expect(() => loadConfig()).toThrow(/exceeds approvers count/);
  });

  it("rejects 0 minimum-approval-count as invalid", () => {
    setInput("approvers", APPROVER_A);
    setInput("minimum-approval-count", "0");
    expect(() => loadConfig()).toThrow(/positive integer/);
  });

  it("rejects non-integer minimum-approval-count", () => {
    setInput("approvers", APPROVER_A);
    setInput("minimum-approval-count", "1.5");
    expect(() => loadConfig()).toThrow(/positive integer/);
  });

  it("rejects 0 timeout-minutes as invalid", () => {
    setInput("approvers", APPROVER_A);
    setInput("timeout-minutes", "0");
    expect(() => loadConfig()).toThrow(/positive integer/);
  });

  it("accepts custom minimum-reject-count", () => {
    setInput("approvers", `${APPROVER_A},${APPROVER_B}`);
    setInput("minimum-reject-count", "2");
    expect(loadConfig().minimumRejectCount).toBe(2);
  });

  it("rejects minimum-reject-count > approvers", () => {
    setInput("approvers", APPROVER_A);
    setInput("minimum-reject-count", "2");
    expect(() => loadConfig()).toThrow(/exceeds approvers count/);
  });

  it("parses multiline JSON payloads correctly", () => {
    setInput("approvers", APPROVER_A);
    setInput(
      "base-message-payload",
      '{\n  "text": "hello\\nworld",\n  "blocks": []\n}',
    );
    const c = loadConfig();
    expect(c.baseMessagePayload).toEqual({ text: "hello\nworld", blocks: [] });
  });

  it("throws on invalid JSON payload", () => {
    setInput("approvers", APPROVER_A);
    setInput("base-message-payload", "{not json");
    expect(() => loadConfig()).toThrow(/base-message-payload.*not valid JSON/);
  });

  it("throws when JSON payload is not an object", () => {
    setInput("approvers", APPROVER_A);
    setInput("base-message-payload", "[1,2,3]");
    expect(() => loadConfig()).toThrow(/must be a JSON object/);
  });

  it("treats base-message-ts as enabling threaded mode", () => {
    setInput("approvers", APPROVER_A);
    setInput("base-message-ts", "1700000000.000100");
    expect(loadConfig().baseMessageTs).toBe("1700000000.000100");
  });

  it("warns when base-message-ts and base-message-payload both set", () => {
    setInput("approvers", APPROVER_A);
    setInput("base-message-ts", "1700000000.000100");
    setInput("base-message-payload", '{"text":"hi"}');
    const writes: string[] = [];
    const spy = jest.spyOn(process.stdout, "write")
      .mockImplementation((chunk: any) => { writes.push(String(chunk)); return true; });
    try { loadConfig(); } finally { spy.mockRestore(); }
    expect(writes.some(w => w.includes("base-message-payload ignored"))).toBe(true);
  });

  it("throws when SLACK_BOT_TOKEN missing", () => {
    setInput("approvers", APPROVER_A);
    delete process.env.SLACK_BOT_TOKEN;
    expect(() => loadConfig()).toThrow(/SLACK_BOT_TOKEN/);
  });

  it("throws when SLACK_BOT_TOKEN has wrong prefix", () => {
    setInput("approvers", APPROVER_A);
    process.env.SLACK_BOT_TOKEN = "xoxp-not-a-bot";
    expect(() => loadConfig()).toThrow(/xoxb-/);
  });

  it("throws when SLACK_APP_TOKEN has wrong prefix", () => {
    setInput("approvers", APPROVER_A);
    process.env.SLACK_APP_TOKEN = "xoxb-not-an-app-token";
    expect(() => loadConfig()).toThrow(/xapp-/);
  });

  it("does not throw when SLACK_SIGNING_SECRET is missing (socket mode)", () => {
    setInput("approvers", APPROVER_A);
    delete process.env.SLACK_SIGNING_SECRET;
    expect(() => loadConfig()).not.toThrow();
  });

  it("throws when channel id missing in both input and env", () => {
    setInput("approvers", APPROVER_A);
    delete process.env.SLACK_CHANNEL_ID;
    expect(() => loadConfig()).toThrow(/channel-id/);
  });

  it("parses prevent-self-approval and self-approval-slack-id", () => {
    setInput("approvers", APPROVER_A);
    setInput("prevent-self-approval", "true");
    setInput("self-approval-slack-id", APPROVER_B);
    const c = loadConfig();
    expect(c.preventSelfApproval).toBe(true);
    expect(c.selfApprovalSlackId).toBe(APPROVER_B);
  });

  it("accepts the largest timeout-minutes a Node timer can hold", () => {
    setInput("approvers", APPROVER_A);
    setInput("timeout-minutes", "35791");
    expect(loadConfig().timeoutMs).toBe(35791 * 60_000);
  });

  it("rejects timeout-minutes beyond the Node timer limit (would fire immediately)", () => {
    setInput("approvers", APPROVER_A);
    setInput("timeout-minutes", "35792");
    expect(() => loadConfig()).toThrow(/timeout-minutes must be at most 35791/);
  });

  it("rejects a quorum that is unreachable once self-approval is blocked", () => {
    setInput("approvers", `${APPROVER_A},${APPROVER_B}`);
    setInput("minimum-approval-count", "2");
    setInput("prevent-self-approval", "true");
    setInput("self-approval-slack-id", APPROVER_A);
    expect(() => loadConfig()).toThrow(/minimum-approval-count \(2\) is unreachable/);
  });

  it("accepts a quorum reachable without the self-approver", () => {
    setInput("approvers", `${APPROVER_A},${APPROVER_B},${APPROVER_C}`);
    setInput("minimum-approval-count", "2");
    setInput("prevent-self-approval", "true");
    setInput("self-approval-slack-id", APPROVER_A);
    expect(loadConfig().minimumApprovalCount).toBe(2);
  });

  it("ignores self-approval-slack-id for quorum when prevent-self-approval is off", () => {
    setInput("approvers", APPROVER_A);
    setInput("self-approval-slack-id", APPROVER_A);
    expect(() => loadConfig()).not.toThrow();
  });

  function captureStdout(fn: () => void): string {
    const writes: string[] = [];
    const spy = jest.spyOn(process.stdout, "write")
      .mockImplementation((chunk: any) => { writes.push(String(chunk)); return true; });
    try { fn(); } finally { spy.mockRestore(); }
    return writes.join("");
  }

  it.each([
    ["empty", ""],
    ["whitespace-only", "   "],
  ])("prevent-self-approval with %s self-approval-slack-id runs, with a titled warning naming the actor", (_label, id) => {
    setInput("approvers", APPROVER_A);
    setInput("prevent-self-approval", "true");
    setInput("self-approval-slack-id", id);
    process.env.GITHUB_ACTOR = "alice";
    let c: ReturnType<typeof loadConfig> | undefined;
    const out = captureStdout(() => { c = loadConfig(); });
    expect(c!.preventSelfApproval).toBe(true);
    expect(c!.selfApprovalSlackId).toBe("");
    expect(out).toContain("::warning title=Self-approval not prevented::");
    expect(out).toMatch(/self-approval is NOT blocked: alice can approve this run/);
  });

  it("does not warn when self-approval-slack-id is set", () => {
    setInput("approvers", APPROVER_A);
    setInput("prevent-self-approval", "true");
    setInput("self-approval-slack-id", APPROVER_B);
    expect(captureStdout(() => loadConfig())).not.toContain("Self-approval not prevented");
  });

  it("rejects malformed self-approval-slack-id", () => {
    setInput("approvers", APPROVER_A);
    setInput("prevent-self-approval", "true");
    setInput("self-approval-slack-id", "not-a-user");
    expect(() => loadConfig()).toThrow(/self-approval-slack-id/);
  });
});
