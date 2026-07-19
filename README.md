# pnx-cli

**PowerNukkitX CLI** - command line tool to manage a **Minecraft Bedrock** server powered by [PowerNukkitX](https://github.com/PowerNukkitX/PowerNukkitX).

Create, start, update and diagnose your server, manage plugins from the marketplace, all with a clean interface and an interactive menu.

## Contents

- [Installation](#installation)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Commands](#commands)
- [Interactive mode](#interactive-mode)
- [Global options](#global-options)
- [Architecture](#architecture)
- [Development](#development)
- [Links](#links)
- [License](#license)

## Installation

```bash
npm install -g @powernukkitx/cli
```

The `pnx` command becomes available.

## Requirements

- **Node.js 20.12+**
- **Java 21+** to run the server ([Adoptium Temurin](https://adoptium.net/) recommended)

## Quick start

```bash
# Contextual interactive menu
pnx

# Create a server then start it
pnx init --dir ./pnx-server
pnx start --memory 4G

# Help
pnx --help
pnx <command> --help
```

## Commands

### `init` - create a server

Downloads the latest `powernukkitx.jar` and the start scripts.

```bash
pnx init --dir ./pnx-server
```

| Option | Description |
|---|---|
| `--dir <path>` | Target directory (prompted otherwise) |
| `--dev` | Development build |

### `start` - start the server

Checks Java, builds optimized JVM arguments (generational ZGC, UTF-8) and launches the server.

```bash
pnx start --memory 4G --restart
```

| Option | Description |
|---|---|
| `--dir <path>` | Server directory |
| `--memory <size>` | Allocated memory, e.g. `2G`, `4G` (default `2G`) |
| `--restart` | Auto restart on crash |
| `--dry-run` | Print the command without running it |

### `stop` - stop the server

Stops the server started through its stored PID.

```bash
pnx stop
```

### `update` - update the core

Backs up the old jar as `.old` then downloads the latest version.

```bash
pnx update --force
```

| Option | Description |
|---|---|
| `--force` | Force re-download (ignore cache) |
| `--dev` | Development build |

### `plugin` - manage plugins

Official marketplace plus local tracking of installed versions.

```bash
pnx plugin list                    # catalog
pnx plugin search essentials       # search
pnx plugin info <slug>             # details
pnx plugin install <slug|url.jar>  # install (marketplace or .jar URL)
pnx plugin installed               # local plugins
pnx plugin update [slug]           # update
pnx plugin remove [name]           # remove
```

Without an argument, `install`, `update` and `remove` offer an interactive selection.

### Diagnostics and utilities

```bash
pnx doctor          # Java, RAM, disk, port 19132, plugins/worlds
pnx info            # status, path, plugins, worlds, RAM
pnx backup          # timestamped server backup
pnx config          # print pnx.yml / server.properties (colored)
pnx use ./server    # set the default server
pnx logs            # latest logs (with live follow)
pnx console         # RCON console attached to the server
```

`doctor` and `info` accept `--json` for machine output.

## Interactive mode

Launched without a subcommand, `pnx` opens a **contextual menu** that:

- detects state (server present, running, PID);
- only offers relevant actions (create if missing, start if stopped, stop if running...);
- routes to the existing commands.

```bash
pnx
```

## Global options

| Option | Description |
|---|---|
| `--json` | Machine JSON output (disables decorative rendering) |
| `--no-color` | Disable colors |

CLI state is stored in `~/.pnx-cli/` (config, PID, installed plugins, version cache). Environment variables: `PNX_API_URL` (marketplace API base), `PNX_HOME` (state directory).

## Architecture

The code follows a layered architecture - thin commands, isolated business logic:

```
dist/
  cli.js          entry point (citty) + global options
  commands/       parse arguments -> call service -> render
    plugin/       plugin subcommands
  services/       pure business logic (release, server, process, plugins, backup)
  infra/          http, JSON store (~/.pnx-cli), constants/endpoints
  ui/             single output system (clack + chalk), prompts
```

Rules: commands do no direct network/file access (everything goes through `services`/`infra`); services render nothing (they return data).

**Stack**: [citty](https://github.com/unjs/citty) (routing), [@clack/prompts](https://github.com/bombshell-dev/clack) (prompts), [chalk](https://github.com/chalk/chalk) (colors).

## Development

The shipped code lives in `dist/` (plain ES modules, no build step).

```bash
npm install       # dependencies
npm start         # run dist/cli.js
npm run check     # syntax check every file
npm run smoke     # run pnx --help
```

## Links

- PowerNukkitX documentation: https://docs.powernukkitx.org
- PowerNukkitX repository: https://github.com/PowerNukkitX/PowerNukkitX

## License

MIT
