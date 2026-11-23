# Contributing to Vantrex IDE

Thanks for taking the time to help. This project is a small, opinionated fork of [Code - OSS](https://github.com/microsoft/vscode); the
goal is a quiet editor that stays easy to keep in step with upstream.

## Before you start

- Search the [issues](https://github.com/nfworking/vtx-editor/issues) first.
- For anything bigger than a small fix, open an issue to discuss it before writing code.
- Security problems go through [SECURITY.md](SECURITY.md), never a public issue.

## Setting up

Follow **Build from source** in the [README](README.md). The short version:

```bash
pnpm install --frozen-lockfile
pnpm run compile-client
./scripts/code.sh
```

After editing TypeScript or CSS, run `pnpm run compile-client` again (the editor reads the compiled output) and restart it. To start from a clean
state, delete the editor's user data folder (`~/Library/Application Support/code-oss-dev` on macOS in a development build).

## Where Vantrex code lives

Keep Vantrex changes in these places rather than spreading them through upstream files; every line changed in an upstream file is a line to
re-resolve on the next merge.

- `src/vs/workbench/contrib/vantrex/` for workbench features and default settings
- `src/vs/workbench/browser/media/vantrex.css` for look and feel
- `extensions/theme-vantrex/` for the colour theme
- `extensions/vantrex-account/` for account sign-in and sync authentication
- `product.json` for product identity and the sync endpoint

When you must change an upstream file, keep the change as small as possible and say why in the pull request.

## Conventions

The code follows the [VS Code coding guidelines](https://github.com/microsoft/vscode/wiki/Coding-Guidelines): tabs for indentation, descriptive
names, user-facing strings through `nls.localize`, and disposables registered as soon as they are created. New files that are not copied from
upstream carry no Microsoft copyright header.

## Pull requests

- Keep each pull request to one change, with a short description of what and why.
- Make sure `pnpm run compile-client` passes. The CI workflow runs it on every pull request.
- For visible changes, include a screenshot.
- By contributing you agree that your work is released under the [MIT License](LICENSE.txt).
