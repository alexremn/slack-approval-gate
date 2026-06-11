import * as core from "@actions/core";
import { App, LogLevel } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { loadConfig } from "./config";
import {
  defaultMainPayload,
  hasPayload,
  readGithubContext,
  renderApprovalReply,
  renderFinalStatus,
  type MessagePayload,
  type Outcome,
} from "./payloads";
import { ApprovalState } from "./approval-state";
import { SlackClient } from "./slack-client";
import { mintActionId } from "./action-id";
import { registerHandlers } from "./handlers";

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let to: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, reject) => {
    to = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (to) clearTimeout(to);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const ghCtx = readGithubContext();
  const aidSeed = `${ghCtx.repo}-${ghCtx.workflow}-${ghCtx.runId}-${ghCtx.runNumber}-${ghCtx.runAttempt}`;
  const approveActionId = mintActionId(`approve:${aidSeed}`);
  const rejectActionId = mintActionId(`reject:${aidSeed}`);

  const web = new WebClient(config.slackBotToken);
  const slack = new SlackClient(web, config.channelId);

  const state = new ApprovalState(
    config.approvers,
    config.minimumApprovalCount,
    config.minimumRejectCount,
  );
  const initialBlocks = renderApprovalReply({
    minimumCount: state.minimumCount,
    remaining: state.getRemaining(),
    approved: state.getApprovers(),
    approveActionId,
    rejectActionId,
  });

  let mainMessageTs: string;
  let approvalMessageTs: string;
  let baseBlocks: unknown[] = [];
  let baseText: string | undefined;

  if (config.baseMessageTs) {
    mainMessageTs = config.baseMessageTs;
    approvalMessageTs = await slack.postApprovalReply(
      mainMessageTs,
      initialBlocks,
    );
  } else {
    const basePayload: MessagePayload = hasPayload(config.baseMessagePayload)
      ? (config.baseMessagePayload as MessagePayload)
      : defaultMainPayload(ghCtx);
    baseBlocks = Array.isArray(basePayload.blocks) ? basePayload.blocks : [];
    baseText = typeof basePayload.text === "string" ? basePayload.text : undefined;
    const combined: Record<string, unknown> = {
      ...(baseText ? { text: baseText } : {}),
      blocks: [...baseBlocks, ...initialBlocks],
    };
    mainMessageTs = await slack.postMain(combined);
    approvalMessageTs = mainMessageTs;
  }

  core.setOutput("main-message-ts", mainMessageTs);
  core.setOutput("approval-message-ts", approvalMessageTs);

  const app = new App({
    token: config.slackBotToken,
    signingSecret: config.slackSigningSecret || undefined,
    appToken: config.slackAppToken,
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

  let shuttingDown = false;
  let timeoutHandle: NodeJS.Timeout | undefined;

  const shutdown = async (
    outcome: Outcome,
    code: number,
  ): Promise<void> => {
    core.setOutput("result", outcome);
    core.setOutput("approvers-json", JSON.stringify(state.getApprovers()));
    core.setOutput("approvals-json", JSON.stringify(state.getApprovalRecords()));
    core.info(`Outcome: ${outcome}`);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    try {
      await withTimeout(app.stop(), 5000, "Bolt app.stop");
    } catch (e) {
      core.warning(`Bolt stop failed: ${(e as Error).message}`);
    }
    process.exit(code);
  };

  registerHandlers({
    app,
    slack,
    state,
    approvalMessageTs,
    approveActionId,
    rejectActionId,
    successPayload: config.successMessagePayload as MessagePayload,
    failPayload: config.failMessagePayload as MessagePayload,
    preventSelfApproval: config.preventSelfApproval,
    selfApprovalSlackId: config.selfApprovalSlackId,
    baseBlocks,
    baseText,
    onTerminal: async (outcome) => {
      if (shuttingDown) return;
      shuttingDown = true;
      const code = outcome === "approved" ? 0 : 1;
      await shutdown(outcome, code);
    },
  });

  const mergeForUpdate = (statusPayload: MessagePayload): MessagePayload => {
    const statusBlocks = Array.isArray(statusPayload.blocks) ? statusPayload.blocks : [];
    return {
      text: statusPayload.text ?? baseText,
      blocks: [...baseBlocks, ...statusBlocks],
    };
  };

  const onCancel = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      // Custom payload replaces the whole message; only the default
      // rendered status gets the standalone base blocks prepended.
      const status: MessagePayload = hasPayload(config.failMessagePayload)
        ? (config.failMessagePayload as MessagePayload)
        : mergeForUpdate({ blocks: renderFinalStatus("canceled", state.getApprovers()) });
      await slack.updateApprovalReply(approvalMessageTs, status);
    } catch (e) {
      core.warning(`Cancel update failed: ${(e as Error).message}`);
    }
    await shutdown("canceled", 1);
  };
  process.on("SIGTERM", onCancel);
  process.on("SIGINT", onCancel);
  process.on("SIGBREAK" as NodeJS.Signals, onCancel);

  timeoutHandle = setTimeout(async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      const status: MessagePayload = hasPayload(config.failMessagePayload)
        ? (config.failMessagePayload as MessagePayload)
        : mergeForUpdate({ blocks: renderFinalStatus("timed-out", state.getApprovers()) });
      await slack.updateApprovalReply(approvalMessageTs, status);
    } catch (e) {
      core.warning(`Timeout update failed: ${(e as Error).message}`);
    }
    await shutdown("timed-out", 1);
  }, config.timeoutMs);
  timeoutHandle.unref?.();

  try {
    await app.start();
  } catch (e) {
    core.error(`Bolt app.start failed: ${(e as Error).message}`);
    if (!shuttingDown) {
      shuttingDown = true;
      try {
        await slack.updateApprovalReply(
          approvalMessageTs,
          mergeForUpdate({
            blocks: renderFinalStatus("canceled", state.getApprovers()),
            text: "Approval listener failed to start; run canceled.",
          }),
        );
      } catch (updErr) {
        core.warning(`Cleanup update failed: ${(updErr as Error).message}`);
      }
      await shutdown("canceled", 1);
    }
    return;
  }
  core.info("Waiting for approval...");
}

main().catch((e: Error) => {
  core.setFailed(e.message);
  process.exit(1);
});
