import { SlackClient } from "../src/slack-client";

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

  it("postMain retries on transient 5xx", async () => {
    const web = makeWeb();
    const err: any = new Error("boom");
    err.statusCode = 503;
    web.chat.postMessage
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ ts: "9.9" });
    const client = new SlackClient(web as any, "C1");
    const ts = await client.postMain({ text: "hi" });
    expect(ts).toBe("9.9");
    expect(web.chat.postMessage).toHaveBeenCalledTimes(2);
  });

  it("postMain does not retry on 4xx", async () => {
    const web = makeWeb();
    const err: any = new Error("bad");
    err.statusCode = 400;
    web.chat.postMessage.mockRejectedValue(err);
    const client = new SlackClient(web as any, "C1");
    await expect(client.postMain({ text: "hi" })).rejects.toThrow(/bad/);
    expect(web.chat.postMessage).toHaveBeenCalledTimes(1);
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
  it("postMain retries when web-api wraps a transient network error", async () => {
    const web = makeWeb();
    const err: any = new Error("A request error occurred: connect ETIMEDOUT");
    err.code = "slack_webapi_request_error";
    err.original = Object.assign(new Error("connect ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    web.chat.postMessage
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ ts: "8.8" });
    const client = new SlackClient(web as any, "C1");
    const ts = await client.postMain({ text: "hi" });
    expect(ts).toBe("8.8");
    expect(web.chat.postMessage).toHaveBeenCalledTimes(2);
  });

  it("postMain does not retry when the wrapped error is not transient", async () => {
    const web = makeWeb();
    const err: any = new Error("A request error occurred: invalid url");
    err.code = "slack_webapi_request_error";
    err.original = Object.assign(new Error("invalid url"), {
      code: "ERR_INVALID_URL",
    });
    web.chat.postMessage.mockRejectedValue(err);
    const client = new SlackClient(web as any, "C1");
    await expect(client.postMain({ text: "hi" })).rejects.toThrow(/invalid url/);
    expect(web.chat.postMessage).toHaveBeenCalledTimes(1);
  });

});
