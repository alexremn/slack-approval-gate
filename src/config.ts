import * as core from "@actions/core";

export interface Config {
  channelId: string;
  baseMessageTs: string | null;
  baseMessagePayload: Record<string, unknown>;
  approvers: string[];
  minimumApprovalCount: number;
  minimumRejectCount: number;
  preventSelfApproval: boolean;
  selfApprovalSlackId: string;
  successMessagePayload: Record<string, unknown>;
  failMessagePayload: Record<string, unknown>;
  timeoutMs: number;
  slackBotToken: string;
  slackAppToken: string;
  slackSigningSecret: string;
}

function parseJsonInput(name: string): Record<string, unknown> {
  const raw = core.getInput(name);
  const trimmed = raw.trim();
  if (!trimmed) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    throw new Error(`Input ${name} is not valid JSON: ${(e as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Input ${name} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function normalizeApprovers(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function parsePositiveInt(name: string, raw: string, fallback: number): number {
  const trimmed = raw.trim();
  if (trimmed === "") return fallback;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`Input ${name} must be a positive integer, got "${raw}"`);
  }
  return n;
}

function parseBool(name: string, raw: string, fallback: boolean): boolean {
  const t = raw.trim().toLowerCase();
  if (t === "") return fallback;
  if (t === "true" || t === "1" || t === "yes") return true;
  if (t === "false" || t === "0" || t === "no") return false;
  throw new Error(`Input ${name} must be true/false, got "${raw}"`);
}

// setTimeout clamps delays above 2^31-1 ms to 1 ms, which would time out at once.
const MAX_TIMEOUT_MINUTES = Math.floor(0x7fffffff / 60_000);

const SLACK_CHANNEL_ID_RE = /^[CGD][A-Z0-9]{6,}$/;
const SLACK_USER_ID_RE = /^[UW][A-Z0-9]{6,}$/;
const APP_TOKEN_RE = /^xapp-/;
const BOT_TOKEN_RE = /^xoxb-/;

export function loadConfig(): Config {
  const channelIdInput = core.getInput("channel-id").trim();
  const channelId = channelIdInput || process.env.SLACK_CHANNEL_ID || "";
  if (!channelId) {
    throw new Error("channel-id input or SLACK_CHANNEL_ID env required");
  }
  if (!SLACK_CHANNEL_ID_RE.test(channelId)) {
    throw new Error(
      `channel-id "${channelId}" is not a valid Slack channel id (expected e.g. C0123ABCD)`,
    );
  }

  const slackBotToken = process.env.SLACK_BOT_TOKEN || "";
  const slackAppToken = process.env.SLACK_APP_TOKEN || "";
  const slackSigningSecret = process.env.SLACK_SIGNING_SECRET || "";
  if (!slackBotToken) throw new Error("SLACK_BOT_TOKEN env required");
  if (!slackAppToken) throw new Error("SLACK_APP_TOKEN env required");
  if (!BOT_TOKEN_RE.test(slackBotToken)) {
    throw new Error("SLACK_BOT_TOKEN must start with xoxb-");
  }
  if (!APP_TOKEN_RE.test(slackAppToken)) {
    throw new Error("SLACK_APP_TOKEN must start with xapp- (Socket Mode app-level token)");
  }

  const baseMessageTsRaw = core.getInput("base-message-ts").trim();
  const baseMessageTs = baseMessageTsRaw.length > 0 ? baseMessageTsRaw : null;

  const baseMessagePayload = parseJsonInput("base-message-payload");
  const successMessagePayload = parseJsonInput("success-message-payload");
  const failMessagePayload = parseJsonInput("fail-message-payload");

  if (baseMessageTs && Object.keys(baseMessagePayload).length > 0) {
    core.warning(
      "base-message-payload ignored: threaded mode active (base-message-ts set)",
    );
  }

  const approvers = normalizeApprovers(
    core.getInput("approvers", { required: true }),
  );
  if (approvers.length === 0) {
    throw new Error("approvers input must contain at least one user id");
  }
  for (const id of approvers) {
    if (!SLACK_USER_ID_RE.test(id)) {
      throw new Error(
        `approvers entry "${id}" is not a valid Slack user id (expected e.g. U0123ABCD)`,
      );
    }
  }

  const minimumApprovalCount = parsePositiveInt(
    "minimum-approval-count",
    core.getInput("minimum-approval-count"),
    1,
  );
  if (minimumApprovalCount > approvers.length) {
    throw new Error(
      `minimum-approval-count (${minimumApprovalCount}) exceeds approvers count (${approvers.length})`,
    );
  }

  const minimumRejectCount = parsePositiveInt(
    "minimum-reject-count",
    core.getInput("minimum-reject-count"),
    1,
  );
  if (minimumRejectCount > approvers.length) {
    throw new Error(
      `minimum-reject-count (${minimumRejectCount}) exceeds approvers count (${approvers.length})`,
    );
  }

  const timeoutMinutes = parsePositiveInt(
    "timeout-minutes",
    core.getInput("timeout-minutes"),
    30,
  );
  if (timeoutMinutes > MAX_TIMEOUT_MINUTES) {
    throw new Error(
      `Input timeout-minutes must be at most ${MAX_TIMEOUT_MINUTES}, got "${timeoutMinutes}"`,
    );
  }

  const preventSelfApproval = parseBool(
    "prevent-self-approval",
    core.getInput("prevent-self-approval"),
    false,
  );
  const selfApprovalSlackId = core.getInput("self-approval-slack-id").trim();
  if (preventSelfApproval && selfApprovalSlackId && !SLACK_USER_ID_RE.test(selfApprovalSlackId)) {
    throw new Error(
      `self-approval-slack-id "${selfApprovalSlackId}" is not a valid Slack user id`,
    );
  }
  if (
    preventSelfApproval &&
    approvers.includes(selfApprovalSlackId) &&
    minimumApprovalCount > approvers.length - 1
  ) {
    throw new Error(
      `minimum-approval-count (${minimumApprovalCount}) is unreachable: self-approval by ${selfApprovalSlackId} is blocked, leaving ${approvers.length - 1} eligible approver(s)`,
    );
  }
  if (preventSelfApproval && !selfApprovalSlackId) {
    core.warning(
      "prevent-self-approval is true but self-approval-slack-id is empty; check will be a no-op",
    );
  }

  return {
    channelId,
    baseMessageTs,
    baseMessagePayload,
    approvers,
    minimumApprovalCount,
    minimumRejectCount,
    preventSelfApproval,
    selfApprovalSlackId,
    successMessagePayload,
    failMessagePayload,
    timeoutMs: timeoutMinutes * 60_000,
    slackBotToken,
    slackAppToken,
    slackSigningSecret,
  };
}
