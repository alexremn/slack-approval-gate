// src/index.ts runs main() on import, so each test loads it in an isolated
// module registry with Slack, timers, process.exit and signals mocked.
// Loading happens inside the test body (the first one also pays the ts-jest
// compile), so allow more than the 5 s default on a busy machine.
jest.setTimeout(30_000);

type Handler = (args: unknown) => Promise<void>;

interface MockApp {
  opts: Record<string, unknown>;
  handlers: Record<string, Handler>;
  start: jest.Mock;
  stop: jest.Mock;
}

const mockApps: MockApp[] = [];
const mockWebClientArgs: unknown[][] = [];
let mockStartError: Error | undefined;
let mockStartHangs = false;
const mockChat = {
  postMessage: jest.fn(),
  update: jest.fn(),
  postEphemeral: jest.fn(),
};
const mockCore = {
  setOutput: jest.fn(),
  setFailed: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
};

// Real getInput (pure over process.env); loaded once, not per isolated registry.
let mockActualCore: typeof import("@actions/core") | undefined;
jest.mock("@actions/core", () => ({
  ...(mockActualCore ??= jest.requireActual<typeof import("@actions/core")>("@actions/core")),
  ...mockCore,
}));
jest.mock("@slack/web-api", () => ({
  WebClient: jest.fn().mockImplementation((...args: unknown[]) => {
    mockWebClientArgs.push(args);
    return { chat: mockChat };
  }),
}));
jest.mock("@slack/bolt", () => ({
  LogLevel: { INFO: "info" },
  App: jest.fn().mockImplementation((opts: Record<string, unknown>) => {
    const handlers: Record<string, Handler> = {};
    const app = {
      opts,
      handlers,
      action: (id: string, fn: Handler) => {
        handlers[id] = fn;
      },
      start: jest.fn(() => {
        if (mockStartHangs) return new Promise<void>(() => {});
        return mockStartError ? Promise.reject(mockStartError) : Promise.resolve();
      }),
      stop: jest.fn().mockResolvedValue(undefined),
    };
    mockApps.push(app);
    return app;
  }),
}));

const CHANNEL = "C0123ABCDE";
const U1 = "U01ABCDEF12";
const U2 = "U02ABCDEF34";

const originalEnv = process.env;
let exitSpy: jest.SpyInstance;
let onSpy: jest.SpyInstance;
let signalHandlers: Record<string, () => Promise<void>>;

function setEnv(inputs: Record<string, string>): void {
  process.env = {
    ...originalEnv,
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_APP_TOKEN: "xapp-test",
    SLACK_CHANNEL_ID: CHANNEL,
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_RUN_ID: "42",
    GITHUB_RUN_NUMBER: "7",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_WORKFLOW: "deploy",
    GITHUB_ACTOR: "alice",
    GITHUB_REF_NAME: "main",
    GITHUB_SHA: "abcdef1234567890",
  };
  for (const [name, value] of Object.entries(inputs)) {
    process.env[`INPUT_${name.toUpperCase()}`] = value;
  }
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) {
    await new Promise(r => setImmediate(r));
  }
  if (!cond()) throw new Error("condition not met");
}

function loadEntrypoint(): void {
  jest.isolateModules(() => {
    require("../src/index");
  });
}

function waitingCount(): number {
  return mockCore.info.mock.calls.filter(c => c[0] === "Waiting for approval...").length;
}

// Resolves once the gate is connected, has posted, and is listening.
async function startGate(inputs: Record<string, string> = {}): Promise<MockApp> {
  const count = mockApps.length;
  const waiting = waitingCount();
  setEnv({ approvers: `${U1},${U2}`, ...inputs });
  loadEntrypoint();
  await until(() => waitingCount() > waiting);
  return mockApps[count];
}

function buttonValues(message: { blocks: Array<{ type: string; elements?: Array<{ value: string }> }> }) {
  const actions = message.blocks.find(b => b.type === "actions")!;
  return { approve: actions.elements![0].value, reject: actions.elements![1].value };
}

function click(app: MockApp, actionId: string, user: string, value: string): Promise<void> {
  return app.handlers[actionId]({
    ack: jest.fn().mockResolvedValue(undefined),
    body: { user: { id: user }, channel: { id: CHANNEL } },
    action: { type: "button", value },
    logger: { error: jest.fn(), info: jest.fn() },
  });
}

function outputs(): Record<string, string> {
  return Object.fromEntries(mockCore.setOutput.mock.calls);
}

function lastUpdateText(): string {
  return JSON.stringify(mockChat.update.mock.calls.at(-1)[0]);
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick", "queueMicrotask"] });
  mockApps.length = 0;
  mockWebClientArgs.length = 0;
  mockStartError = undefined;
  mockStartHangs = false;
  mockChat.postMessage.mockResolvedValue({ ts: "1.0" });
  mockChat.update.mockResolvedValue({ ok: true });
  mockChat.postEphemeral.mockResolvedValue({ ok: true });
  signalHandlers = {};
  const realOn = process.on.bind(process);
  onSpy = jest.spyOn(process, "on").mockImplementation(((event: string, fn: () => Promise<void>) => {
    if (event.startsWith("SIG")) {
      signalHandlers[event] = fn;
      return process;
    }
    return realOn(event, fn);
  }) as typeof process.on);
  exitSpy = jest.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  exitSpy.mockRestore();
  onSpy.mockRestore();
  process.env = originalEnv;
});

describe("entrypoint", () => {
  it("standalone: posts one message with GitHub context and buttons, exposes its ts", async () => {
    const app = await startGate();
    expect(mockChat.postMessage).toHaveBeenCalledTimes(1);
    const msg = mockChat.postMessage.mock.calls[0][0];
    expect(msg.channel).toBe(CHANNEL);
    expect(msg.thread_ts).toBeUndefined();
    expect(msg.blocks[0].type).toBe("header");
    expect(msg.blocks.some((b: { type: string }) => b.type === "actions")).toBe(true);
    expect(outputs()).toMatchObject({ "main-message-ts": "1.0", "approval-message-ts": "1.0" });
    expect(app.opts).toMatchObject({ token: "xoxb-test", appToken: "xapp-test", socketMode: true });
    expect(mockWebClientArgs).toEqual([
      ["xoxb-test", expect.objectContaining({ timeout: expect.any(Number), retryConfig: expect.any(Object) })],
    ]);
  });

  it("button values carry the gate's deadline so other gates can spot expired buttons", async () => {
    await startGate({ "timeout-minutes": "5" });
    const { approve, reject } = buttonValues(mockChat.postMessage.mock.calls[0][0]);
    expect(approve).toMatch(/^[0-9a-f]{16}\.\d+$/);
    expect(Number(approve.split(".")[1])).toBe(Date.now() + 5 * 60_000);
    expect(reject.split(".")[1]).toBe(approve.split(".")[1]);
  });

  it("standalone with base-message-payload: custom text/blocks precede the buttons", async () => {
    await startGate({
      "base-message-payload": '{"text":"Deploy v2","blocks":[{"type":"section","text":{"type":"mrkdwn","text":"CTX"}}]}',
    });
    const msg = mockChat.postMessage.mock.calls[0][0];
    expect(msg.text).toBe("Deploy v2");
    expect(msg.blocks[0]).toEqual({ type: "section", text: { type: "mrkdwn", text: "CTX" } });
    expect(msg.blocks.at(-1).type).toBe("actions");
  });

  it("threaded: replies under base-message-ts and never posts a main message", async () => {
    mockChat.postMessage.mockResolvedValue({ ts: "2.0" });
    await startGate({ "base-message-ts": "1.5" });
    expect(mockChat.postMessage).toHaveBeenCalledTimes(1);
    expect(mockChat.postMessage.mock.calls[0][0].thread_ts).toBe("1.5");
    expect(outputs()).toMatchObject({ "main-message-ts": "1.5", "approval-message-ts": "2.0" });
  });

  it("approval: updates the message, sets outputs, stops Bolt and exits 0", async () => {
    const app = await startGate();
    const { approve } = buttonValues(mockChat.postMessage.mock.calls[0][0]);
    await click(app, "slack-approval-approve", U1, approve);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
    const out = outputs();
    expect(out.result).toBe("approved");
    expect(JSON.parse(out["approvers-json"])).toEqual([U1]);
    expect(JSON.parse(out["approvals-json"])[0].user).toBe(U1);
    expect(app.stop).toHaveBeenCalled();
    expect(lastUpdateText()).toContain("Approved");
  });

  it("rejection: updates the message and exits 1 with result=rejected", async () => {
    const app = await startGate();
    const { reject } = buttonValues(mockChat.postMessage.mock.calls[0][0]);
    await click(app, "slack-approval-reject", U2, reject);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(outputs().result).toBe("rejected");
    expect(lastUpdateText()).toContain("Rejected");
  });

  it("timeout: marks the message timed out and exits 1", async () => {
    await startGate({ "timeout-minutes": "1" });
    await jest.advanceTimersByTimeAsync(60_000);
    await until(() => exitSpy.mock.calls.length > 0);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(outputs().result).toBe("timed-out");
    expect(lastUpdateText()).toContain("Timed out");
  });

  it("SIGTERM: marks the message canceled, exits 1 once, ignores repeated signals", async () => {
    await startGate();
    await signalHandlers.SIGTERM();
    await signalHandlers.SIGINT();
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(outputs().result).toBe("canceled");
    expect(mockChat.update).toHaveBeenCalledTimes(1);
    expect(lastUpdateText()).toContain("Canceled");
  });

  it("timer and signal during the final approval update do not override the approval", async () => {
    const app = await startGate({ "timeout-minutes": "1" });
    const { approve } = buttonValues(mockChat.postMessage.mock.calls[0][0]);
    let release!: () => void;
    mockChat.update.mockImplementationOnce(
      () => new Promise(r => { release = () => r({ ok: true }); }),
    );
    const pending = click(app, "slack-approval-approve", U1, approve);
    await until(() => mockChat.update.mock.calls.length === 1);
    await jest.advanceTimersByTimeAsync(60_000);
    await signalHandlers.SIGTERM();
    release();
    await pending;
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(outputs().result).toBe("approved");
    expect(mockChat.update).toHaveBeenCalledTimes(1);
  });

  it("connects to Slack before posting, so early clicks are not lost", async () => {
    const app = await startGate();
    expect(app.start.mock.invocationCallOrder[0])
      .toBeLessThan(mockChat.postMessage.mock.invocationCallOrder[0]);
  });

  it("Bolt start failure: fails the step and never posts buttons nobody can answer", async () => {
    mockStartError = new Error("socket refused");
    setEnv({ approvers: `${U1},${U2}` });
    loadEntrypoint();
    await until(() => exitSpy.mock.calls.length > 0);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockCore.setFailed).toHaveBeenCalledWith(expect.stringContaining("socket refused"));
    expect(outputs().result).toBe("canceled");
    expect(mockChat.postMessage).not.toHaveBeenCalled();
  });

  it("a Slack connection that never completes fails the step after 60 s", async () => {
    mockStartHangs = true;
    setEnv({ approvers: `${U1},${U2}` });
    loadEntrypoint();
    await until(() => mockApps.length > 0 && mockApps[0].start.mock.calls.length > 0);
    await jest.advanceTimersByTimeAsync(60_000);
    await until(() => exitSpy.mock.calls.length > 0);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockCore.setFailed).toHaveBeenCalledWith(expect.stringMatching(/timed out/));
    expect(outputs().result).toBe("canceled");
    expect(mockChat.postMessage).not.toHaveBeenCalled();
  });

  it.each<[string, () => Promise<void>, string]>([
    ["timeout", () => jest.advanceTimersByTimeAsync(60_000), "timed-out"],
    ["SIGTERM", () => signalHandlers.SIGTERM(), "canceled"],
  ])("Slack down during %s: warns and still exits 1 with the right result", async (_name, trigger, result) => {
    await startGate({ "timeout-minutes": "1" });
    mockChat.update.mockRejectedValue(new Error("invalid_auth"));
    await trigger();
    await until(() => exitSpy.mock.calls.length > 0);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(outputs().result).toBe(result);
    expect(mockCore.warning).toHaveBeenCalledWith(expect.stringContaining("invalid_auth"));
  });

  it("Bolt stop failure is logged and the run still exits with its outcome", async () => {
    const app = await startGate();
    app.stop.mockRejectedValueOnce(new Error("socket stuck"));
    const { approve } = buttonValues(mockChat.postMessage.mock.calls[0][0]);
    await click(app, "slack-approval-approve", U1, approve);
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(mockCore.warning).toHaveBeenCalledWith(expect.stringContaining("socket stuck"));
  });

  it("timeout with custom fail-message-payload lists who approved before the deadline", async () => {
    const app = await startGate({
      "timeout-minutes": "1",
      "minimum-approval-count": "2",
      "fail-message-payload": '{"text":"Expired; approved so far: {{approvers}}"}',
    });
    const { approve } = buttonValues(mockChat.postMessage.mock.calls[0][0]);
    await click(app, "slack-approval-approve", U1, approve);
    await jest.advanceTimersByTimeAsync(60_000);
    await until(() => exitSpy.mock.calls.length > 0);
    expect(outputs().result).toBe("timed-out");
    expect(JSON.parse(outputs()["approvers-json"])).toEqual([U1]);
    expect(mockChat.update.mock.calls.at(-1)[0].text).toBe(`Expired; approved so far: <@${U1}>`);
  });

  it("invalid config: fails the step without touching Slack", async () => {
    setEnv({ approvers: "not-a-user" });
    loadEntrypoint();
    await until(() => exitSpy.mock.calls.length > 0);
    expect(mockCore.setFailed).toHaveBeenCalledWith(expect.stringMatching(/not a valid Slack user id/));
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockChat.postMessage).not.toHaveBeenCalled();
    expect(mockApps).toHaveLength(0);
  });

  it("gates in the same run (matrix legs) get distinct button ids and never act on each other's clicks", async () => {
    await startGate();
    const gateB = await startGate();
    const a = buttonValues(mockChat.postMessage.mock.calls[0][0]);
    const b = buttonValues(mockChat.postMessage.mock.calls[1][0]);
    expect(a.approve).not.toBe(b.approve);
    expect(a.reject).not.toBe(b.reject);

    await click(gateB, "slack-approval-approve", U1, a.approve);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockChat.update).not.toHaveBeenCalled();
    expect(mockChat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ user: U1, channel: CHANNEL, text: expect.stringMatching(/different approval gate/) }),
    );

    await click(gateB, "slack-approval-approve", U1, b.approve);
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(JSON.parse(outputs()["approvers-json"])).toEqual([U1]);
  });
});
