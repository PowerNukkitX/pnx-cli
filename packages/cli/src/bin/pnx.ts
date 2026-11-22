#!/usr/bin/env node
import { argv } from 'node:process';
import { setColorEnabled, c, S } from '../ui/theme.js';
import { VERSION } from '../infra/version.js';
import { findCommand, GROUPS, COMMANDS } from '../cli/registry.js';
import { renderRootHelp, renderCommandHelp } from '../cli/help.js';
import { nearest, parseArgv, type CommandSpec } from '../cli/define.js';
import { sayCancelled, closeRailWithError } from '../ui/kit.js';
import { json } from '../infra/json.js';

/**
 * The front door.
 *
 * Three facts shape everything below. A mistyped flag deserves its one error
 * line, not the whole usage screen above it. A stack trace belongs behind a
 * flag, because somebody whose Java is too old is not helped by seeing which
 * function noticed. And an exit code is the only part of a failure a script
 * reads, so there is always one, and it is zero only when nothing was wrong.
 */

const HELP_FLAGS = new Set(['--help', '-h']);
const VERSION_FLAGS = new Set(['--version', '-v']);

const rawArgs = argv.slice(2);

// `pnx --help | head` closes the pipe early: that is the reader's choice, not a crash
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0);
    throw error;
});
const debug = rawArgs.includes('--debug') || Boolean(process.env.PNX_DEBUG);

// colour follows the conventions every modern tool honours: --no-color and
// NO_COLOR (no-color.org) switch it off, --color and FORCE_COLOR force it on
// (CI logs render ANSI), and a pipe gets plain text unless asked otherwise
const forceColor = rawArgs.includes('--color') || (Boolean(process.env.FORCE_COLOR) && process.env.FORCE_COLOR !== '0');
const noColor = rawArgs.includes('--no-color') || 'NO_COLOR' in process.env || process.env.TERM === 'dumb';
if (!rawArgs.includes('--color') && (noColor || (!forceColor && !process.stdout.isTTY))) setColorEnabled(false);

/**
 * How a run fails, in one place. One line of cause, one of `hint`, and an
 * exit code - everything an operator or a script needs, nothing they don't.
 */
function fail(message: string, hint?: string, cause?: unknown): never {
    // a run that opened its rail closes it with the error, in its own shape
    if (!closeRailWithError(message, hint)) {
        process.stderr.write(`${c.error(S.cross)} ${message}\n`);
        if (hint) process.stderr.write(`  ${c.muted(hint)}\n`);
    }
    if (debug && cause instanceof Error && cause.stack) {
        process.stderr.write(`\n${c.dim(cause.stack)}\n`);
    }
    process.exit(1);
}

/** The hint that goes with an error nobody anticipated by name. */
function hintFor(cause: unknown): string {
    const error = cause as { name?: string; hint?: string; statusCode?: number; code?: string } | null;
    if (error?.name === 'CliError') {
        if (error.hint) return error.hint;
        const word = rawArgs.find((token) => !token.startsWith('-'));
        return `Run \`pnx ${word ? `${word} ` : ''}--help\`.`;
    }
    if (error?.name === 'NetworkError' || error?.name === 'HttpError') {
        if (error.statusCode === 403 || error.statusCode === 429) {
            return 'GitHub is rate-limiting this address. Wait an hour, or set GITHUB_TOKEN.';
        }
        if (error.statusCode && error.statusCode >= 500) return 'The server on the other end is failing. Try again later.';
        return 'Check your internet connection (or proxy), then try again.';
    }
    if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'Permission denied: run from a folder you own.';
    if (error?.code === 'ENOSPC') return 'The disk is full.';
    return 'Re-run with --debug for the full trace.';
}

/** Exits 0 with one line: the user chose to stop, and that is not a failure. */
function exitCancelled(): never {
    sayCancelled('Cancelled - nothing was changed.');
}

/**
 * Walks a command path so `pnx plugin install --help` reaches the leaf. Stops
 * at the first token that does not resolve, so a positional argument is never
 * mistaken for a verb.
 */
function descend(spec: CommandSpec, rest: string[]): { spec: CommandSpec; path: string[] } {
    let current = spec;
    const path: string[] = [];
    for (const token of rest) {
        if (token.startsWith('-')) break;
        const candidate = current.name === 'plugin' ? `plugin ${token}` : `${current.name} ${token}`;
        const next = findCommand(candidate);
        if (!next) break;
        current = next;
        path.push(token);
    }
    return { spec: current, path };
}

async function main(): Promise<void> {
    // the shells' completion scripts call this on every <Tab>: answer fast,
    // never print anything else, never fail loudly
    if (rawArgs[0] === '__complete') {
        const { runComplete } = await import('../commands/completion.js');
        await runComplete(rawArgs.slice(1).filter((word) => word !== ''));
        return;
    }

    // global switches are valid anywhere on the line, before a command or
    // after it: they stop being words the dispatcher needs to see
    const GLOBAL_SWITCHES = new Set(['--no-color', '--color', '--json']);
    const words = rawArgs.filter((token) => token !== '--debug' && !GLOBAL_SWITCHES.has(token));

    if (words.length === 0) {
        if (process.env.CI && json.isJson()) {
            json.emit({ version: VERSION, commands: COMMANDS.length });
            return;
        }
        const { runMenu } = await import('../commands/menu.js');
        await runMenu();
        return;
    }

    // `pnx help` and `pnx help plugin install` - the spelling somebody tries first
    if (words[0] === 'help') {
        words.shift();
        const spec = words.length > 0
            ? (resolveCommand(words.join(' ')) ?? resolveCommand(words[0]!))
            : null;
        if (!spec) return renderRootHelp(COMMANDS, GROUPS, VERSION);
        return renderCommandHelp(descend(spec, words).spec);
    }

    const token = words[0]!.startsWith('-') ? null : words[0]!;
    if (!token) {
        if (words.some((token2) => VERSION_FLAGS.has(token2))) {
            process.stdout.write(`${VERSION}\n`);
            return;
        }
        if (words.some((token2) => HELP_FLAGS.has(token2))) return renderRootHelp(COMMANDS, GROUPS, VERSION);
        return fail(
            `No command given. What should pnx do?`,
            `Run \`pnx --help\` for the list, or just \`pnx\` for the interactive launcher.`,
        );
    }

    const spec = resolveCommand(token);
    if (!spec) unknownCommandMessage(token);

    let rest = words.slice(1);
    if (HELP_FLAGS.has(rest.find((word) => HELP_FLAGS.has(word)) ?? '')) {
        return renderCommandHelp(descend(spec, rest).spec);
    }

    let target = descend(spec, rest.filter((word) => !word.startsWith('-')));

    // the verb tokens that chose this command are not arguments to it:
    // `pnx plugin search foo` hands the run `foo`, not `search foo`
    let consumed = [...target.path];
    rest = rest.filter((token) => {
        if (consumed.length > 0 && token === consumed[0]) {
            consumed = consumed.slice(1);
            return false;
        }
        return true;
    });

    const parsed = parseArgv(rest, target.spec);

    if ((target.spec.positionals ?? []).filter((arg) => arg.required).length > parsed.positionals.length) {
        const missing = target.spec.positionals![parsed.positionals.length]!;
        return fail(
            `\`pnx ${target.spec.name}\` needs <${missing.name}>`,
            `Run \`pnx ${target.spec.name} --help\` for the full form.`,
        );
    }

    await target.spec.run({ args: parsed });
}

/** Resolves a full name or alias, or suggests better spellings. */
function resolveCommand(name: string): CommandSpec | null {
    return findCommand(name);
}

function unknownCommandMessage(name: string): never {
    const guess = nearest(name, COMMANDS.flatMap((entry) => [entry.name, ...(entry.aliases ?? [])]));
    const line = guess
        ? `\`${name}\` is not a pnx command. Did you mean \`pnx ${guess}\`?`
        : `\`${name}\` is not a pnx command.`;
    process.stderr.write(`${c.error(S.cross)} ${line}\n`);
    process.stderr.write(`  ${c.muted('Run `pnx --help` for the full list, or `pnx` for the menu.')}\n`);
    process.exit(1);
}

process.on('unhandledRejection', (reason) => {
    fail(reason instanceof Error ? reason.message : String(reason), hintFor(reason), reason);
});

const { startUpdateCheck, finishUpdateCheck } = await import('../infra/update-check.js');
if (rawArgs[0] !== '__complete') await startUpdateCheck().catch(() => undefined);

main()
    .then(() => finishUpdateCheck().catch(() => undefined))
    .catch((cause) => {
        if (cause?.name === 'CancelledError') exitCancelled();
        fail(cause instanceof Error ? cause.message : String(cause), hintFor(cause), cause);
    });
