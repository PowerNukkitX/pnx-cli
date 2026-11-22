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
  <a href="#scripting">Scripting</a> ·
  <a href="#development">Development</a> ·
  <a href="https://github.com/PowerNukkitX/pnx-app">Desktop app</a>
</p>

---

**`pnx`** runs a [PowerNukkitX](https://powernukkitx.org) Minecraft Bedrock
server from one command. It downloads the right jar, writes the start scripts,
picks the Java flags, installs reviewed plugins, takes backups and tells you the
address your friends join. It is pleasant to use in a terminal and safe to use
in scripts.

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

`pnx start` shows the addresses to join, one spinner while the world loads,
then tells you when players can connect:

```text
  ◆ PowerNukkitX 3.0.6
  - Local:    127.0.0.1:19132
  - Network:  192.168.1.15:19132
  - Java:     25 (Temurin) · up to 2G

✓ Ready in 3.1s  · 3 warnings (pnx logs)
  Type a server command here · Ctrl+C or `pnx stop` saves and stops
```

The package installs two commands: `pnx`, the full tool, and `pnxcli`, a
guided launcher that only creates a server and offers to start it.

## Why pnx

|  |  |
| :-- | :-- |
| **Step by step** | Every command shows its progress on one rail: questions, numbered steps with timings, then a card with what to do next. |
| **A real dashboard** | `pnx` on its own opens a menu with the current server, whether it runs, its version and the address to join. |
| **Knows your server** | Tab completion for bash, zsh, fish and PowerShell covers commands, options, `pnx.yml` keys and backup names. |
| **Safe by default** | `stop` saves the world first, `backup restore` takes a safety copy first, `config set` keeps every comment. |
| **Made for scripts** | Non-zero exit codes on failure, `--json` on every read, no prompts without a terminal. |
| **Zero dependencies** | Nothing to audit at runtime, and `npx` starts fast. |

## Commands

**Server**

| | |
| :-- | :-- |
| `pnx init [dir]` | Create a server: PowerNukkitX and its start scripts (`-y` takes every default) |
| `pnx start` | Run it in the foreground (Ctrl+C saves and stops it) |
| `pnx stop` | Save the world and stop it, from any terminal |
| `pnx status` | Whether it runs, since when, and the address players join |
| `pnx cmd <command>` | Type on the running server's console (no RCON needed) |
| `pnx console` | A console over RCON (needs RCON enabled) |
| `pnx logs` | Read the log, and follow it |
| `pnx config [get\|set]` | Show `pnx.yml`, or read or change one value by its key |
| `pnx open [config\|logs\|plugins]` | Open the folder in your file manager or editor |
| `pnx use` | Pick the server every command works on |

**Plugins**, from the PowerNukkitX hub (reviewed releases only, checked against their SHA-256)

| | |
| :-- | :-- |
| `pnx plugin list` / `search` / `info` | Browse the marketplace |
| `pnx plugin install` / `update` / `remove` | Manage the `plugins/` folder |
| `pnx plugin installed` | What is installed |

**Maintenance**

| | |
| :-- | :-- |
| `pnx update` | The newest PowerNukkitX, the old jar kept as `.old` |
| `pnx backup [list\|restore\|prune]` | Back up, browse, restore (with a safety copy), keep the newest *n* |
| `pnx doctor` | Check Java, memory, disk and the configured port |
| `pnx info` | The server, its version and this machine |
| `pnx link` | Pair the server with a hub dashboard |
| `pnx completion` | Turn on Tab completion |

Short forms work too: `pnx install <name>`, `pnx search <word>`, `pnx uninstall <name>`.
Every command has `--help`, and the [documentation](https://powernukkitx.org/docs/cli) covers each one.

## Scripting

| | |
| :-- | :-- |
| `--json` | Machine-readable output, one JSON document per command |
| `--no-color`, `NO_COLOR=1` | Plain text (`--color` or `FORCE_COLOR=1` force colour on) |
| `--debug`, `PNX_DEBUG=1` | Full stack trace under an error |
| `PNX_ASCII=1` | ASCII instead of Unicode symbols |
| `PNX_HOME` | Where `pnx` keeps its state (default `~/.pnx-cli`) |
| `PNX_NO_UPDATE_CHECK=1` | Skip the once-a-day check for a newer `pnx` |

Without a terminal, `pnx` never prompts, and any failure ends with a non-zero
exit code.

`~/.pnx-cli` holds the default server, the release cache and the hub token. The
[desktop app](https://github.com/PowerNukkitX/pnx-app) reads the same folder,
so it finds the servers you made with `pnx`.

## Desktop app

Prefer a window? **[PowerNukkitX](https://github.com/PowerNukkitX/pnx-app)**
(Windows, Linux, macOS) bundles this CLI and adds a live console, a players
panel, a visual `pnx.yml` editor and servers on a VPS over SSH. Downloads are on
its [latest release](https://github.com/PowerNukkitX/pnx-app/releases/latest).

## Development

```
packages/cli/   @powernukkitx/cli: the pnx and pnxcli commands (TypeScript)
assets/         README banners (rebuilt by packages/cli/scripts/make-banner.mjs)
```

```bash
npm install
npm run build          # compile to packages/cli/dist
npm run cli:dev        # pnx --help, from source
npm run typecheck
npm run smoke          # smoke test the built CLI
```

To work on the desktop app as well, clone
[pnx-app](https://github.com/PowerNukkitX/pnx-app) next to this repository: it
loads `../pnx-cli/packages/cli/dist`. `npm run icons` regenerates its icons.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

### Releasing

Bump `version` in `packages/cli/package.json` and push to `master`. The
[Release workflow](.github/workflows/release.yml) checks, builds and publishes
the CLI to npm, then creates the GitHub release `cli-vX.Y.Z`. Its English
changelog is written from the commits
([Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`…;
bullet lines in the body become sub-items).

The `app-vX.Y.Z` releases here are copies published by pnx-app. Desktop app
copies up to 2.4.0 update from this repository, and these releases move them
over to pnx-app.

## Privacy

`pnx` does not send any information to other systems unless the user, or
whoever installs or runs it, asks it to.

What it contacts, and why:

- `powernukkitx.org`: the PowerNukkitX release list, the plugin hub (search,
  install, update) and, only if you link an account, your hub token.
- `github.com`, `api.github.com`, `raw.githubusercontent.com`: downloading
  PowerNukkitX.
- `api.adoptium.net`, `adoptium.net`: finding a Java runtime when you ask for one.
- `registry.npmjs.org`: the once-a-day check for a newer version
  (`PNX_NO_UPDATE_CHECK=1` turns it off).

No analytics, telemetry or crash reports are collected.

## License

[MIT](LICENSE) © AzaleeX and the PowerNukkitX contributors
