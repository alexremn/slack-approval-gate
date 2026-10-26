import { LogLevel, WebClient } from "@slack/web-api";
import { SlackClient, WEB_CLIENT_OPTIONS } from "../src/slack-client";

function makeWeb() {
  return {
    chat: {
      postMessage: jest.fn(),
      update: jest.fn(),
      postEphemeral: jest.fn(),
    },
  };
}

describe("SlackClient", () => {
  afterEach(() => jest.useRealTimers());

  it("postMain sends payload and returns ts", async () => {
    const web = makeWeb();
    web.chat.postMessage.mockResolvedValue({ ts: "1.0" });
    const client = new SlackClient(web as any, "C1");
    const ts = await client.postMain({ text: "hi" });
    expect(ts).toBe("1.0");
    expect(web.chat.postMessage).toHaveBeenCalledWith({ channel: "C1", text: "hi" });
  });

  it("postMain injects fallback text when caller omits it", async () => {
    const web = makeWeb();
    web.chat.postMessage.mockResolvedValue({ ts: "1.0" });
    const client = new SlackClient(web as any, "C1");
    await client.postMain({ blocks: [{ type: "section" }] });
    const call = web.chat.postMessage.mock.calls[0][0];
    expect(call.text).toBe("Approval request");
  });

  it("postMain throws when ts is missing", async () => {
    const web = makeWeb();
    web.chat.postMessage.mockResolvedValue({});
    const client = new SlackClient(web as any, "C1");
    await expect(client.postMain({ text: "hi" })).rejects.toThrow(/no ts/);
  });

  it("postApprovalReply posts with thread_ts and returns ts", async () => {
    const web = makeWeb();
    web.chat.postMessage.mockResolvedValue({ ts: "2.0" });
    const client = new SlackClient(web as any, "C1");
    const ts = await client.postApprovalReply("1.0", [{ type: "section" }]);
    expect(ts).toBe("2.0");
    expect(web.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C1",
        thread_ts: "1.0",
        blocks: [{ type: "section" }],
      }),
    );
  });

  it("updateApprovalReply targets ts and channel", async () => {
    const web = makeWeb();
    web.chat.update.mockResolvedValue({ ok: true });
    const client = new SlackClient(web as any, "C1");
    await client.updateApprovalReply("2.0", { blocks: [{ type: "section" }] });
    expect(web.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C1",
        ts: "2.0",
        blocks: [{ type: "section" }],
      }),
    );
  });

  it("updateApprovalReply passes empty blocks array when blocks undefined", async () => {
    const web = makeWeb();
    web.chat.update.mockResolvedValue({ ok: true });
    const client = new SlackClient(web as any, "C1");
    await client.updateApprovalReply("2.0", { text: "hi" });
    expect(web.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C1", ts: "2.0", text: "hi", blocks: [] }),
    );
  });

  it("postEphemeral targets user", async () => {
    const web = makeWeb();
    web.chat.postEphemeral.mockResolvedValue({ ok: true });
    const client = new SlackClient(web as any, "C1");
    await client.postEphemeral("U1", "nope", "2.0");
    expect(web.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C1",
        user: "U1",
        text: "nope",
        thread_ts: "2.0",
      }),
    );
  });
  it("postEphemeral can target another channel", async () => {
    const web = makeWeb();
    web.chat.postEphemeral.mockResolvedValue({ ok: true });
    const client = new SlackClient(web as any, "C1");
    await client.postEphemeral("U1", "nope", undefined, "C2");
    expect(web.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C2", user: "U1", thread_ts: undefined }),
    );
  });

  it("updates are sent one at a time, in call order", async () => {
    const web = makeWeb();
    let releaseFirst!: () => void;
    web.chat.update
      .mockImplementationOnce(() => new Promise(r => { releaseFirst = () => r({ ok: true }); }))
      .mockResolvedValue({ ok: true });
    const client = new SlackClient(web as any, "C1");
    const first = client.updateApprovalReply("2.0", { text: "progress" });
    const second = client.updateApprovalReply("2.0", { text: "final" });
    await new Promise(r => setImmediate(r));
    expect(web.chat.update).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(web.chat.update.mock.calls.map(c => c[0].text)).toEqual(["progress", "final"]);
  });

  it("an update stuck on Slack holds the next one back for at most 3 s", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick", "queueMicrotask"] });
    const web = makeWeb();
    web.chat.update
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue({ ok: true });
    const client = new SlackClient(web as any, "C1");
    void client.updateApprovalReply("2.0", { text: "stuck progress" });
    const cancel = client.updateApprovalReply("2.0", { text: "canceled" });
    await jest.advanceTimersByTimeAsync(2_999);
    expect(web.chat.update).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(cancel).resolves.toBeUndefined();
    expect(web.chat.update.mock.calls[1][0].text).toBe("canceled");
  });

  it("a failed update does not block the ones after it", async () => {
    const web = makeWeb();
    web.chat.update.mockRejectedValueOnce(new Error("boom")).mockResolvedValue({ ok: true });
    const client = new SlackClient(web as any, "C1");
    const first = client.updateApprovalReply("2.0", { text: "a" });
    const second = client.updateApprovalReply("2.0", { text: "b" });
    await expect(first).rejects.toThrow(/boom/);
    await expect(second).resolves.toBeUndefined();
  });
});

// Real WebClient with WEB_CLIENT_OPTIONS and a fake fetch: exercises
// @slack/web-api's own retry/timeout handling, which SlackClient relies on.
describe("SlackClient over a real WebClient", () => {
  const retries = (WEB_CLIENT_OPTIONS.retryConfig as { retries: number }).retries;

  function realClient(fetchImpl: jest.Mock, timeout = WEB_CLIENT_OPTIONS.timeout): SlackClient {
    const web = new WebClient("xoxb-test", {
      ...WEB_CLIENT_OPTIONS,
      timeout,
      // Same retry count; zero backoff so the tests run in milliseconds.
      retryConfig: { ...WEB_CLIENT_OPTIONS.retryConfig, minTimeout: 0, maxTimeout: 0 },
      fetch: fetchImpl as unknown as typeof fetch,
      logLevel: LogLevel.ERROR,
    });
    return new SlackClient(web, "C1");
  }

  function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  }

  it("bounds every request with a timeout and a few retries", () => {
    expect(WEB_CLIENT_OPTIONS.timeout).toBe(10_000);
    expect(retries).toBe(4);
  });

  it("retries a Slack 5xx and succeeds", async () => {
    const fetchImpl = jest.fn()
      .mockImplementationOnce(async () => reply(503, { ok: false }))
      .mockImplementationOnce(async () => reply(200, { ok: true, ts: "9.9" }));
    await expect(realClient(fetchImpl).postMain({ text: "hi" })).resolves.toBe("9.9");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries a network error and succeeds", async () => {
    const fetchImpl = jest.fn()
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      })
      .mockImplementationOnce(async () => reply(200, { ok: true, ts: "8.8" }));
    await expect(realClient(fetchImpl).postMain({ text: "hi" })).resolves.toBe("8.8");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("waits out a 429 and retries", async () => {
    const fetchImpl = jest.fn()
      .mockImplementationOnce(async () => reply(429, { ok: false, error: "ratelimited" }, { "retry-after": "0" }))
      .mockImplementationOnce(async () => reply(200, { ok: true }));
    await expect(realClient(fetchImpl).updateApprovalReply("2.0", { text: "x" })).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry a Slack platform error", async () => {
    const fetchImpl = jest.fn(async () => reply(200, { ok: false, error: "channel_not_found" }));
    await expect(realClient(fetchImpl).postMain({ text: "hi" })).rejects.toThrow(/channel_not_found/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up on a persistent 5xx after the configured retries", async () => {
    const fetchImpl = jest.fn(async () => reply(500, { ok: false }));
    await expect(realClient(fetchImpl).postEphemeral("U1", "t")).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(retries + 1);
  });

  it("aborts a request that never answers and gives up after the configured retries", async () => {
    const fetchImpl = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    );
    await expect(realClient(fetchImpl, 20).updateApprovalReply("1.0", { text: "x" })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(retries + 1);
  });


});
