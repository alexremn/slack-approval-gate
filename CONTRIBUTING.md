# Contributing

Thanks for your interest in improving **slack-approval-gate**.

## Getting started

```bash
npm ci
npm test          # jest
npm run typecheck # tsc --noEmit
npm run build     # bundles src/ -> dist/ via ncc
```

Requires Node.js `>=24` (see `engines` in `package.json`).

## Workflow

1. Fork the repo and create a branch off `main`.
2. Make your change. Keep it focused — one logical change per PR.
3. Add or update tests. The suite must stay green.
4. **Rebuild `dist/`** if you touched anything under `src/`. The action runs the
   committed bundle (`dist/index.js`), so a stale `dist/` ships broken code.
   CI fails when `dist/` is out of sync with `src/`.
5. Run `npm test` and `npm run typecheck` before pushing.
6. Open a PR using the template. Describe the change and link any issue.

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add minimum-reject-count input
fix: drop late button press after terminal outcome
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

## Reporting bugs / requesting features

Use the [issue templates](https://github.com/alexremn/slack-approval-gate/issues/new/choose).
For security issues see [SECURITY.md](./SECURITY.md) — do not open a public issue.

## License

By contributing you agree your work is licensed under the [MIT License](./LICENSE).
