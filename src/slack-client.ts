import type { WebClient, WebClientOptions } from "@slack/web-api";
import type { KnownBlock } from "@slack/types";

// web-api retries network errors, timeouts, 5xx and 429 itself, but by default
// with no request timeout and for ~30 minutes, so a stalled Slack call could
// block the final update long past the decision. Abort each request after
// 10 s and retry up to 4 times with jittered backoff: a stalled or failing call
// gives up within ~2 minutes. Rate limits still wait out Slack's Retry-After.
export const WEB_CLIENT_OPTIONS: WebClientOptions = {
  timeout: 10_000,
  retryConfig: { retries: 4, randomize: true },
};

export interface UpdatePayload {
  text?: string;
  blocks?: unknown[];
}

const DEFAULT_FALLBACK_TEXT = "Approval request";

// How long an update waits for the previous one. Bounded so a stuck progress
// update cannot hold back a cancel update past the runner's ~7.5 s SIGINT grace.
const UPDATE_QUEUE_WAIT_MS = 3_000;

function waitAtMost(p: Promise<unknown>, ms: number): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  const elapsed = new Promise(r => { timer = setTimeout(r, ms); });
  return Promise.race([p, elapsed]).finally(() => clearTimeout(timer));
}

export class SlackClient {
  // Message updates go out one at a time, in call order, so a slow or retried
  // progress update cannot land after (and overwrite) the final status. The
  // wait is bounded (UPDATE_QUEUE_WAIT_MS) so a stuck one cannot block forever.
  private updates: Promise<unknown> = Promise.resolve();

  constructor(private readonly web: WebClient, private readonly channel: string) {}

  async postMain(payload: Record<string, unknown>): Promise<string> {
    const p = payload as { text?: unknown };
    const text = typeof p.text === "string" && p.text.length > 0
      ? p.text
      : "Approval request";
    const res = await this.web.chat.postMessage({
      channel: this.channel,
      text,
      ...(payload as object),
    } as Parameters<WebClient["chat"]["postMessage"]>[0]);
    if (!res.ts) throw new Error("Slack chat.postMessage returned no ts");
    return res.ts;
  }

  async postApprovalReply(threadTs: string, blocks: unknown[]): Promise<string> {
    const res = await this.web.chat.postMessage({
      channel: this.channel,
      thread_ts: threadTs,
      text: DEFAULT_FALLBACK_TEXT,
      blocks: blocks as unknown as KnownBlock[],
    });
    if (!res.ts) throw new Error("Slack chat.postMessage returned no ts");
    return res.ts;
  }

  async updateApprovalReply(ts: string, payload: UpdatePayload): Promise<void> {
    const update = waitAtMost(this.updates, UPDATE_QUEUE_WAIT_MS).then(() =>
      this.web.chat.update({
        channel: this.channel,
        ts,
        text: payload.text ?? "Approval status",
        blocks: (payload.blocks ?? []) as unknown as KnownBlock[],
      }),
    );
    this.updates = update.catch(() => undefined);
    await update;
  }

  async postEphemeral(
    user: string,
    text: string,
    threadTs?: string,
    channel = this.channel,
  ): Promise<void> {
    await this.web.chat.postEphemeral({
      channel,
      user,
      text,
      thread_ts: threadTs,
    });
  }
}
