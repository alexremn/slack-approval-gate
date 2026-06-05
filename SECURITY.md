# Security Policy

## Supported versions

The latest major version tag (`v1`) and `main` receive security fixes. Older
tags are not maintained.

## Reporting a vulnerability

Do **not** open a public issue for security problems.

Report privately via GitHub's [Security Advisories](https://github.com/alexremn/slack-approval-gate/security/advisories/new),
or email **alexander.remniov@gmail.com**.

Please include:

- A description of the issue and its impact.
- Steps to reproduce or a proof of concept.
- Affected version / commit.

You can expect an initial response within 7 days. Once confirmed, a fix and a
patched release tag will follow, and you will be credited unless you prefer to
stay anonymous.

## Handling secrets

This action consumes Slack tokens (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`). Always
pass them through [GitHub Actions secrets](https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions),
never as plaintext in workflow files or logs.
