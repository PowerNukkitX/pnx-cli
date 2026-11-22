<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/banner-light.svg">
    <img alt="PowerNukkitX CLI - create, run and look after Minecraft Bedrock servers" src="assets/banner-dark.svg" width="100%">
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@powernukkitx/cli"><img alt="npm" src="https://img.shields.io/npm/v/@powernukkitx/cli?color=25d35c&label=npm&logo=npm"></a>
  <a href="https://github.com/PowerNukkitX/pnx-cli/actions"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/PowerNukkitX/pnx-cli/ci.yml?branch=master&label=CI&logo=github"></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A520.12-25d35c?logo=node.js&logoColor=white">
  <img alt="Java" src="https://img.shields.io/badge/java-25-25d35c?logo=openjdk&logoColor=white">
  <img alt="Dependencies" src="https://img.shields.io/badge/runtime%20deps-0-25d35c">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-25d35c"></a>
</p>

<p align="center">
  <a href="https://powernukkitx.org/docs/cli"><b>Documentation</b></a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#powernukkitx-desktop-app">Desktop app</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

---

**`pnx`** turns a PowerNukkitX server into a one-command job. It downloads the
right jar, writes the start scripts, picks the Java flags, installs reviewed
plugins, takes backups and tells you the address your friends join, all
from a terminal that is pleasant to use and safe to script.

```text
┌   pnx  init  create a new server
│
◇  Where should the server live?
│  survival
│
◇  1/3  Downloading powernukkitx.jar  89.5 MB in 5.6s
◇  2/3  Start scripts written (start.bat, start.ps1)
◇  3/3  Set as the default server
│
◇  Next steps ───────────────────────────╮
│                                        │
│  cd survival                           │
│  pnx start   # Ctrl+C saves and stops  │
│                                        │
├────────────────────────────────────────╯
│
└  ✓ Created survival with PowerNukkitX 3.0.6 in 6.4s
```

## Quick start

You need [Node.js 20.12+](https://nodejs.org) and [Java 25](https://adoptium.net).

```bash
npx @powernukkitx/cli init survival     # create a server
cd survival
npx @powernukkitx/cli start             # run it
```

Or install it once and use `pnx` everywhere:

```bash
npm install -g @powernukkitx/cli
pnx                                     # the interactive dashboard
```

`pnx start` reads like `next dev`: the addresses to join, one spinner while the
world loads, then the moment players can connect.

```text
  ◆ PowerNukkitX 3.0.6
  - Local:    127.0.0.1:19132
  - Network:  192.168.1.15:19132
  - Java:     25 (Temurin) · up to 2G

✓ Ready in 3.1s  · 3 warnings (pnx logs)
  Type a server command here · Ctrl+C or `pnx stop` saves and stops
```

## Why pnx

|  |  |
| :-- | :-- |
| **Step by step** | Every command draws its story on one rail: questions, numbered steps with timings, a card with what to do next. |
| **A real dashboard** | `pnx` alone opens a menu that shows which server, whether it runs, its version and the address to join. |
| **Knows your server** | Tab completion for bash, zsh, fish and PowerShell completes commands, options, `pnx.yml` keys and backup names. |
| **Safe by default** | `stop` saves the world first, `backup restore` takes a safety copy first, `config set` keeps every comment. |
| **Made for scripts** | Non-zero exit codes on failure, `--json` on every read, `NO_COLOR` / `FORCE_COLOR`, no prompts without a terminal. |
| **Zero dependencies** | Nothing to audit at runtime; `npx` starts fast. |

## Commands

| | |
| :-- | :-- |
| `pnx init [dir]` | Create a server (`-y` takes every default) |
| `pnx start` / `stop` | Run it in the foreground; save and stop it from any terminal |
| `pnx status` | Is it up, since when, and the address players join |
| `pnx cmd <command>` | Type on the running server's console (no RCON needed) |
| `pnx logs` | Read and follow the log |
| `pnx config [get\|set]` | Show `pnx.yml`, or read / change one value by its key |
| `pnx plugin install\|search\|update\|remove` | The PowerNukkitX plugin marketplace |
| `pnx backup [list\|restore\|prune]` | Back up, browse, restore (with a safety copy), keep the newest *n* |
| `pnx update` | The newest PowerNukkitX, the old jar kept as `.old` |
| `pnx doctor` | Java, memory, disk and the configured port, checked |
| `pnx open [config\|logs\|plugins]` | Open the folder in your file manager or editor |
| `pnx completion` | Turn on Tab completion |

Every command has `--help`, and the [documentation](https://powernukkitx.org/docs/cli) covers each one.

## PowerNukkitX desktop app

The same engine, in a desktop window. **PowerNukkitX** (Electron,
Windows / Linux / macOS) drives the very functions `pnx` uses: a multi-server
registry, a live console with search and quick commands, a players panel, the
plugin marketplace, a visual `pnx.yml` editor, backups and restore, in-place
core updates and crash auto-restart, in five languages.

```bash
npm run app:start       # dev window
npm run app:dist        # Windows installer (app:dist:linux, app:dist:mac)
```

## Repository

```
packages/cli/   @powernukkitx/cli - the pnx and pnxcli commands (TypeScript)
packages/app/   PowerNukkitX - the desktop app (Electron)
assets/         README banners (rebuilt by packages/cli/scripts/make-banner.mjs)
```

```bash
npm install            # both workspaces
npm run build          # compile the CLI
npm run cli:dev        # pnx --help, from source
npm run typecheck
```

Runtime state lives in `~/.pnx-cli` (or `PNX_HOME`): the default server, the
release cache, the hub token and the desktop app's preferences.

## License

[MIT](LICENSE) © AzaleeX and the PowerNukkitX contributors
