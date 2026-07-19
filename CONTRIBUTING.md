# Contributing to PowerNukkitX CLI

Thanks for taking the time to contribute. This document explains how to get set up and what we expect from a pull request.

## Getting started

Requirements:

- Node.js >= 20.12.0
- npm

Install and run locally:

```bash
npm install
node dist/cli.js --help
```

You can link the CLI globally to test the `pnx` binary:

```bash
npm link
pnx --help
```

## Project layout

The shipped code lives under `dist/`:

- `dist/cli.js` - entry point, wires up the citty command tree
- `dist/commands/` - one file per command (start, stop, plugin, backup, ...)
- `dist/services/` - business logic (process control, backups, plugin registry, releases)
- `dist/infra/` - low level helpers (http, filesystem paths, key-value store)
- `dist/ui/` - terminal output, prompts and theme
## User facing text

All user facing text is hardcoded English in the command files. Keep messages short and consistent with the surrounding ones.

## Pull requests

- Keep changes focused and small.
- Do not commit `node_modules/`.
- Make sure `node --check` passes on every file you touch and that `node dist/cli.js --help` still runs.
- Describe what changed and why in the PR body.

## Reporting bugs

Open an issue using the bug report template and include your OS, Node version and the exact command you ran.
