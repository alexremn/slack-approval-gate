import * as core from "@actions/core";
import type { App } from "@slack/bolt";
import type { ApprovalState } from "./approval-state";
import type { SlackClient } from "./slack-client";
import {
  hasPayload,
  renderApprovalReply,
  renderFinalStatus,
  type ApprovalReplyState,
  type MessagePayload,
  type Outcome,
} from "./payloads";

export interface HandlersDeps {
  app: App;
  slack: SlackClient;
  state: ApprovalState;
  approvalMessageTs: string;
  approveActionId: string;
  rejectActionId: string;
  successPayload: MessagePayload;
  failPayload: MessagePayload;
  preventSelfApproval?: boolean;
  selfApprovalSlackId?: string;
  baseBlocks?: unknown[];
  baseText?: string;
  onTerminal: (outcome: Outcome, rejectedBy?: string) => Promise<void>;
}

function buildReplyState(
  state: ApprovalState,
  approveId: string,
  rejectId: string,
): ApprovalReplyState {
  return {
    minimumCount: state.minimumCount,
    remaining: state.getRemaining(),
    approved: state.getApprovers(),
    approveActionId: approveId,
    rejectActionId: rejectId,
  };
}

export function registerHandlers(deps: HandlersDeps): void {
  const {
    app,
    slack,
    state,
    approvalMessageTs,
    approveActionId,
    rejectActionId,
    successPayload,
    failPayload,
    preventSelfApproval = false,
    selfApprovalSlackId = "",
    baseBlocks = [],
    baseText,
    onTerminal,
  } = deps;

  const mergeUpdate = (status: MessagePayload): MessagePayload => {
    if (baseBlocks.length === 0) return status;
    const statusBlocks = Array.isArray(status.blocks) ? status.blocks : [];
    return {
      text: status.text ?? baseText,
      blocks: [...baseBlocks, ...statusBlocks],
    };
  };

  let terminalFired = false;

  app.action("slack-approval-approve", async ({ ack, body, action, logger }) => {
    await ack();
    if (terminalFired) return;
    if (action.type !== "button" || (action as { type: string; value?: string }).value !== approveActionId) return;

    const userId = (body as { user: { id: string } }).user.id;

    try {
      if (preventSelfApproval && selfApprovalSlackId && userId === selfApprovalSlackId) {
        await slack.postEphemeral(
          userId,
          "Self-approval is disabled for this run (you triggered the workflow).",
          approvalMessageTs,
        );
        core.info(`Self-approval blocked for ${userId}`);
        return;
      }

      const result = await state.tryApprove(userId);
      if (result === "not-authorized") {
        core.info(`Unauthorized approve attempt by ${userId}`);
        await slack.postEphemeral(
          userId,
          "You are not authorized to approve this request.",
          approvalMessageTs,
        );
        return;
      }
      if (result === "already-approved") {
        await slack.postEphemeral(
          userId,
          "You have already approved this request.",
          approvalMessageTs,
        );
        return;
      }
      if (result === "remaining") {
        core.info(`Approval recorded from ${userId}; ${state.getApprovers().length}/${state.minimumCount}`);
        try {
          await slack.updateApprovalReply(
            approvalMessageTs,
            mergeUpdate({
              blocks: renderApprovalReply(
                buildReplyState(state, approveActionId, rejectActionId),
              ),
            }),
          );
        } catch (e) {
          logger.error(e as Error);
        }
        return;
      }
      // result === "approved"
      core.info(`Approval threshold reached; final approver ${userId}`);
      terminalFired = true;
      // Custom payload replaces the whole message; only the default
      // rendered status gets the standalone base blocks prepended.
      const finalPayload = hasPayload(successPayload)
        ? successPayload
        : mergeUpdate({ blocks: renderFinalStatus("approved", state.getApprovers()) });
      try {
        await slack.updateApprovalReply(approvalMessageTs, finalPayload);
      } catch (e) {
        logger.error(e as Error);
      }
      await onTerminal("approved");
    } catch (e) {
      logger.error(e as Error);
    }
  });

  app.action("slack-approval-reject", async ({ ack, body, action, logger }) => {
    await ack();
    if (terminalFired) return;
    if (action.type !== "button" || (action as { type: string; value?: string }).value !== rejectActionId) return;

    const userId = (body as { user: { id: string } }).user.id;
    try {
      const result = await state.tryReject(userId);
      if (result === "not-authorized") {
        core.info(`Unauthorized reject attempt by ${userId}`);
        await slack.postEphemeral(
          userId,
          "You are not authorized to reject this request.",
          approvalMessageTs,
        );
        return;
      }
      if (result === "already-rejected") {
        await slack.postEphemeral(
          userId,
          "You have already rejected this request.",
          approvalMessageTs,
        );
        return;
      }
      if (result === "remaining") {
        core.info(`Rejection recorded from ${userId}; ${state.getRejecters().length}/${state.minimumRejectCount}`);
        try {
          await slack.updateApprovalReply(
            approvalMessageTs,
            mergeUpdate({
              blocks: renderApprovalReply(
                buildReplyState(state, approveActionId, rejectActionId),
              ),
            }),
          );
        } catch (e) {
          logger.error(e as Error);
        }
        return;
      }
      // result === "rejected"
      core.info(`Rejection threshold reached; final rejecter ${userId}`);
      terminalFired = true;
      const finalPayload = hasPayload(failPayload)
        ? failPayload
        : mergeUpdate({ blocks: renderFinalStatus("rejected", state.getApprovers(), userId) });
      try {
        await slack.updateApprovalReply(approvalMessageTs, finalPayload);
      } catch (e) {
        logger.error(e as Error);
      }
      await onTerminal("rejected", userId);
    } catch (e) {
      logger.error(e as Error);
    }
  });
}
