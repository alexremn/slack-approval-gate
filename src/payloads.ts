export interface MessagePayload {
  text?: string;
  blocks?: unknown[];
}

export function hasPayload(p: MessagePayload | Record<string, unknown> | undefined): boolean {
  if (!p) return false;
  const text = (p as MessagePayload).text;
  const blocks = (p as MessagePayload).blocks;
  if (typeof text === "string" && text.length > 0) return true;
  if (Array.isArray(blocks) && blocks.length > 0) return true;
  return false;
}

export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface GithubContext {
  serverUrl: string;
  repo: string;
  runId: string;
  runNumber: string;
  runAttempt: string;
  workflow: string;
  runnerOs: string;
  actor: string;
  refName: string;
  sha: string;
}

export function readGithubContext(): GithubContext {
  return {
    serverUrl: process.env.GITHUB_SERVER_URL || "",
    repo: process.env.GITHUB_REPOSITORY || "",
    runId: process.env.GITHUB_RUN_ID || "",
    runNumber: process.env.GITHUB_RUN_NUMBER || "",
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || "",
    workflow: process.env.GITHUB_WORKFLOW || "",
    runnerOs: process.env.RUNNER_OS || "",
    actor: process.env.GITHUB_ACTOR || "",
    refName: process.env.GITHUB_REF_NAME || "",
    sha: process.env.GITHUB_SHA || "",
  };
}

export function defaultMainPayload(ctx: GithubContext): MessagePayload {
  const repoUrl = `${ctx.serverUrl}/${ctx.repo}`;
  const runUrl = `${repoUrl}/actions/runs/${ctx.runId}`;
  const attemptSuffix =
    ctx.runAttempt && ctx.runAttempt !== "1" ? ` (attempt ${ctx.runAttempt})` : "";
  const workflowLabel = ctx.runNumber
    ? `${escapeMrkdwn(ctx.workflow)} #${ctx.runNumber}${attemptSuffix}`
    : escapeMrkdwn(ctx.workflow);

  const fields: Array<{ type: "mrkdwn"; text: string }> = [
    { type: "mrkdwn", text: `*Repository*\n<${repoUrl}|${escapeMrkdwn(ctx.repo)}>` },
    { type: "mrkdwn", text: `*Workflow*\n<${runUrl}|${workflowLabel}>` },
    {
      type: "mrkdwn",
      text: `*Triggered by*\n<${ctx.serverUrl}/${ctx.actor}|${escapeMrkdwn(ctx.actor)}>`,
    },
  ];
  if (ctx.refName) {
    fields.push({
      type: "mrkdwn",
      text: `*Branch*\n<${repoUrl}/tree/${ctx.refName}|${escapeMrkdwn(ctx.refName)}>`,
    });
  }
  if (ctx.sha) {
    const shortSha = ctx.sha.slice(0, 7);
    fields.push({
      type: "mrkdwn",
      text: `*Commit*\n<${repoUrl}/commit/${ctx.sha}|${shortSha}>`,
    });
  }

  return {
    text: `Approval required: ${ctx.workflow} in ${ctx.repo}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "🔒 Approval required", emoji: true },
      },
      {
        type: "section",
        fields,
      },
    ],
  };
}

export interface ApprovalReplyState {
  minimumCount: number;
  remaining: string[];
  approved: string[];
  approveActionId: string;
  rejectActionId: string;
}

export function renderApprovalReply(state: ApprovalReplyState): unknown[] {
  const stillNeeded = Math.max(0, state.minimumCount - state.approved.length);
  const eligibleText =
    state.remaining.length > 0
      ? state.remaining.map(v => `<@${v}>`).join(", ")
      : "(none)";
  const lines = [
    `*Required approvals:* ${state.minimumCount}`,
    `*Still needed:* ${stillNeeded}`,
    `*Eligible approvers:* ${eligibleText}`,
  ];
  if (state.approved.length > 0) {
    lines.push(`*Approved by:* ${state.approved.map(v => `<@${v}>`).join(", ")}`);
  }
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: lines.join("\n"),
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", emoji: true, text: "approve" },
          style: "primary",
          value: state.approveActionId,
          action_id: "slack-approval-approve",
        },
        {
          type: "button",
          text: { type: "plain_text", emoji: true, text: "reject" },
          style: "danger",
          value: state.rejectActionId,
          action_id: "slack-approval-reject",
        },
      ],
    },
  ];
}

export interface TemplateVars {
  approvers: string[];
  rejecters: string[];
}

function mentionList(userIds: string[]): string {
  return userIds.map(id => `<@${id}>`).join(", ");
}

export function substituteTemplateVars(
  payload: MessagePayload,
  vars: TemplateVars,
): MessagePayload {
  if (!hasPayload(payload)) return payload;
  // Tokens are replaced on the serialized payload so they work anywhere —
  // text, block contents, nested fields. Slack mentions contain no
  // JSON-significant characters, so the result stays valid JSON.
  const json = JSON.stringify(payload)
    .replace(/\{\{\s*approvers\s*\}\}/g, mentionList(vars.approvers))
    .replace(/\{\{\s*rejecters\s*\}\}/g, mentionList(vars.rejecters));
  return JSON.parse(json) as MessagePayload;
}

export type Outcome = "approved" | "rejected" | "canceled" | "timed-out";

export function renderFinalStatus(
  outcome: Outcome,
  approvers: string[],
  rejectedBy?: string,
): unknown[] {
  let text: string;
  switch (outcome) {
    case "approved":
      text =
        `Approved :white_check_mark:` +
        (approvers.length > 0
          ? ` by ${approvers.map(v => `<@${v}>`).join(", ")}`
          : "");
      break;
    case "rejected":
      text = `Rejected${rejectedBy ? ` by <@${rejectedBy}>` : ""} :x:`;
      break;
    case "canceled":
      text = "Canceled :radio_button: :leftwards_arrow_with_hook:";
      break;
    case "timed-out":
      text = "Timed out :hourglass:";
      break;
  }
  return [{ type: "section", text: { type: "mrkdwn", text } }];
}
