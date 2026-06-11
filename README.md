# slack-approval-gate

GitHub Action that gates a workflow on Slack approval. Two modes:

- **Threaded**: pass `base-message-ts` and the action posts the approval reply in that message's thread. The pre-existing main message is never modified; state is reflected on the reply.
- **Standalone**: omit `base-message-ts` and the action posts a single message combining `base-message-payload` (or a default GitHub-context block) with the approval prompt, then updates that same message in place as state changes. No thread reply is created.

In both modes the message carrying the buttons is the one updated as approvals/rejections come in (in-progress, approved, rejected, canceled, timed-out). In standalone, that's the main message itself; in threaded, it's the reply. On the terminal update, a custom `success-message-payload`/`fail-message-payload` fully replaces that message; with no custom payload, the default one-line status is appended below the base blocks (standalone) or replaces the reply (threaded).

## Slack app setup

Create a Slack App in your workspace with this manifest:

```json
{
  "display_information": { "name": "ApproveApp" },
  "features": {
    "bot_user": { "display_name": "ApproveApp", "always_online": false }
  },
  "oauth_config": {
    "scopes": {
      "bot": ["app_mentions:read", "channels:join", "chat:write", "users:read"]
    }
  },
  "settings": {
    "interactivity": { "is_enabled": true },
    "org_deploy_enabled": false,
    "socket_mode_enabled": true,
    "token_rotation_enabled": false
  }
}
```

## Required env

| Variable | Description |
|----------|-------------|
| `SLACK_APP_TOKEN` | App-level token from Basic Information (`xapp-…`). |
| `SLACK_BOT_TOKEN` | Bot token from OAuth & Permissions (`xoxb-…`). |
| `SLACK_CHANNEL_ID` | Default channel ID (overridable by `channel-id` input). |

> **Note:** `SLACK_SIGNING_SECRET` is not required when using Socket Mode (the default).

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `channel-id` | no | env `SLACK_CHANNEL_ID` | Slack channel ID. Must match `^[CGD][A-Z0-9]{6,}$`. |
| `base-message-ts` | no | — | Enables threaded mode. |
| `base-message-payload` | no | `{}` (uses built-in GH-context block when empty) | Standalone-mode main message JSON. Must be a JSON object. |
| `approvers` | yes | — | Comma-separated Slack user IDs (`U…`/`W…`). |
| `minimum-approval-count` | no | `1` | Approvals needed. Must be a positive integer and `≤ approvers.length`. |
| `minimum-reject-count` | no | `1` | Rejections needed. Must be a positive integer and `≤ approvers.length`. |
| `prevent-self-approval` | no | `false` | If `true`, the workflow's triggering actor cannot approve. Requires `self-approval-slack-id`. |
| `self-approval-slack-id` | no | — | Slack user id of the triggering actor (mapping is the caller's responsibility). |
| `success-message-payload` | no | rendered block | Replaces the approval message on full approval. In standalone mode it replaces the entire message (base blocks included), so include any context you want to keep. |
| `fail-message-payload` | no | rendered block | Replaces the approval message on reject/cancel/timeout. Same standalone-mode semantics as `success-message-payload`. |
| `timeout-minutes` | no | `30` | Action-level approval timeout. **Independent of step-level `timeout-minutes:`** — whichever fires first wins. Always pass this with `with:` rather than relying on the step-level setting. |

## Outputs

| Output | Description |
|--------|-------------|
| `main-message-ts` | Main message ts. In threaded mode, equals the input. |
| `approval-message-ts` | Ts of the message that carries the buttons and gets updated. Equals `main-message-ts` in standalone mode; the thread reply ts in threaded mode. |
| `result` | `approved`, `rejected`, `canceled`, or `timed-out`. |
| `approvers-json` | JSON array of user IDs who approved. |
| `approvals-json` | JSON array of `{user, ts}` records (`ts` = epoch milliseconds). |

## Usage

### Standalone mode

```yaml
jobs:
  approval:
    runs-on: ubuntu-latest
    steps:
      - name: gate
        uses: alexremn/slack-approval-gate@v1
        env:
          SLACK_APP_TOKEN: ${{ secrets.SLACK_APP_TOKEN }}
          SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}
          SLACK_CHANNEL_ID: ${{ secrets.SLACK_CHANNEL_ID }}
        with:
          approvers: U12345,U67890
          minimum-approval-count: 2
```

### Threaded mode

```yaml
- name: post context
  id: post
  uses: slackapi/slack-github-action@v1
  with:
    channel-id: ${{ secrets.SLACK_CHANNEL_ID }}
    payload: |
      { "text": "Deploy requested for ${{ github.sha }}" }

- name: gate
  uses: alexremn/slack-approval-gate@v1
  env:
    SLACK_APP_TOKEN: ${{ secrets.SLACK_APP_TOKEN }}
    SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}
    SLACK_CHANNEL_ID: ${{ secrets.SLACK_CHANNEL_ID }}
  with:
    base-message-ts: ${{ steps.post.outputs.ts }}
    approvers: U12345,U67890
```

## Behavior

- Approve / reject buttons live on the approval reply.
- Non-approver click → ephemeral "not authorized" reply to that user (approve and reject both).
- Double-approve / double-reject click → ephemeral "already approved/rejected".
- Self-approval, when `prevent-self-approval=true` and the clicker's Slack id matches `self-approval-slack-id`, is blocked with an ephemeral reply.
- Reject reaches terminal after `minimum-reject-count` rejections (default 1).
- SIGTERM / SIGINT / SIGBREAK → reply updated with the cancel block, job exits with code 1 (`result=canceled`).
- Timeout → reply updated with the timed-out block, job exits with code 1 (`result=timed-out`).
- A late button press after the terminal outcome is dropped.
- Slack API calls retry transient failures (HTTP 429 / 5xx / `ratelimited` / `ETIMEDOUT` / `ECONNRESET`) with jittered exponential backoff (up to 3 attempts).
- `core.info` logs include each approve / reject event, threshold reached, and final outcome.

### Timeout caveat

`timeout-minutes` is the **action's own approval timer**. GitHub Actions' step-level `timeout-minutes:` is a separate killer of the whole step. They are independent — set them consistently:

```yaml
- name: gate
  uses: alexremn/slack-approval-gate@v1
  timeout-minutes: 240           # GitHub step kill
  with:
    timeout-minutes: 240         # action's own approval timer
    approvers: U12345,U67890
```

If you only set the step-level `timeout-minutes:` the action will still default to 30 minutes internally and exit early as `timed-out`.

## Contributing

Contributions welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, the
`dist/` rebuild rule, and commit conventions. Security issues: see
[SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE) © Alexander Remniov
