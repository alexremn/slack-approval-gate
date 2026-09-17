import type { WebClient } from "@slack/web-api";
import type { KnownBlock } from "@slack/types";

export interface UpdatePayload {
  text?: string;
  blocks?: unknown[];
}

const DEFAULT_FALLBACK_TEXT = "Approval request";

async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  baseMs = 300,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isRetryable(e) || i === attempts - 1) throw e;
      const jitter = Math.floor(Math.random() * 100);
      await new Promise(r => setTimeout(r, baseMs * 2 ** i + jitter));
    }
  }
  throw lastErr;
}

// @slack/web-api wraps network failures in a WebAPIRequestError, whose own code
// is "slack_webapi_request_error" and whose .original holds the node error.
const TRANSIENT_CODES = ["ETIMEDOUT", "ECONNRESET"];

function isRetryable(e: unknown): boolean {
  const err = e as {
    code?: string;
    data?: { error?: string };
    statusCode?: number;
    original?: { code?: string };
  };
  if (err?.statusCode && err.statusCode >= 500) return true;
  if (err?.statusCode === 429) return true;
  if (TRANSIENT_CODES.includes(err?.code ?? "")) return true;
  if (TRANSIENT_CODES.includes(err?.original?.code ?? "")) return true;
  if (err?.data?.error === "ratelimited") return true;
  return false;
}

export class SlackClient {
  constructor(private readonly web: WebClient, private readonly channel: string) {}

  async postMain(payload: Record<string, unknown>): Promise<string> {
    const p = payload as { text?: unknown };
    const text = typeof p.text === "string" && p.text.length > 0
      ? p.text
      : "Approval request";
    const res = await withRetry(() =>
      this.web.chat.postMessage({
        channel: this.channel,
        text,
        ...(payload as object),
      } as Parameters<WebClient["chat"]["postMessage"]>[0]),
    );
    if (!res.ts) throw new Error("Slack chat.postMessage returned no ts");
    return res.ts;
  }

  async postApprovalReply(threadTs: string, blocks: unknown[]): Promise<string> {
    const res = await withRetry(() =>
      this.web.chat.postMessage({
        channel: this.channel,
        thread_ts: threadTs,
        text: DEFAULT_FALLBACK_TEXT,
        blocks: blocks as unknown as KnownBlock[],
      }),
    );
    if (!res.ts) throw new Error("Slack chat.postMessage returned no ts");
    return res.ts;
  }

  async updateApprovalReply(ts: string, payload: UpdatePayload): Promise<void> {
    await withRetry(() =>
      this.web.chat.update({
        channel: this.channel,
        ts,
        text: payload.text ?? "Approval status",
        blocks: (payload.blocks ?? []) as unknown as KnownBlock[],
      }),
    );
  }

  async postEphemeral(user: string, text: string, threadTs?: string): Promise<void> {
    await withRetry(() =>
      this.web.chat.postEphemeral({
        channel: this.channel,
        user,
        text,
        thread_ts: threadTs,
      }),
    );
  }
}
