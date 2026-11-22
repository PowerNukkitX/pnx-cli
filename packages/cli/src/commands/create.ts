import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { cwd } from 'node:process';
import { CliError } from '../cli/define.js';
import {
    askSelect,
    askText,
    downloadBar,
    introHead,
    isInteractive,
    log,
    nextSteps,
    note,
    outroTail,
    railIsOpen,
    spinner,
    tasks,
} from '../ui/kit.js';
import { c } from '../ui/theme.js';
import { listReleases, downloadCore, type Release } from '../services/release.js';
import { setDefaultServer, officialStartScripts } from '../services/server.js';
import { downloadFile } from '../infra/http.js';
import { JAR_NAME } from '../infra/paths.js';
import { json } from '../infra/json.js';


/**
 * Creating a server, for both `pnx init` and the `pnxcli` launcher.
 *
 * One flow, two doors. The commands give it arguments and flags; the launcher
 * walks in with nothing and answers prompts. Either way the steps are the same
 * four - directory, version, download, scripts - and this file is the only
 * place that knows them, so the launcher can never drift from the CLI.
 */

export interface CreateOptions {
    dir?: string;
    version?: string;
    /** take every default instead of asking (`pnx init -y`, like `create-next-app --yes`) */
    yes?: boolean;
}

export interface CreateResult {
    serverDir: string;
    release: Release;
    size: number;
}

/** True when a prompt would be possible at all. */
function canPrompt(): boolean {
    return isInteractive() && !process.env.CI;
}

/**
 * Answers a question from a prompt when the terminal allows, and refuses with
 * the right sentence when it does not. Typed <T>: a prompt answers whatever the
 * caller need, not only strings.
 */
async function promptOr<T>(message: string, prompt: () => Promise<T>): Promise<T> {
    if (canPrompt()) return prompt();
    throw new CliError(
        message,
        'Interactive prompts need a terminal; pass the values as flags instead.',
    );
}

/** The shared builder. Throws `CliError` on anything that should be a message. */
export async function runCreate(options: CreateOptions): Promise<CreateResult> {
    // a run of its own opens its rail; inside the launcher it hangs off theirs
    if (!railIsOpen()) introHead('pnx init', 'create a new server');

    // ── directory ────────────────────────────────────────────────────────────
    let target = options.dir ?? (options.yes ? 'pnx-server' : undefined);
    const askedDir = !target;
    if (!target) {
        target = await promptOr('Where should the server be created? Tell me with --dir <path>.', async () => {
            const answer = await askText({
                message: 'Where should the server live?',
                placeholder: 'pnx-server',
                defaultValue: 'pnx-server',
                validate: (value) => {
                    if (!value || !value.trim()) return 'Give the directory a name or keep the default.';
                    if (existsSync(join(resolve(cwd(), value.trim()), JAR_NAME))) {
                        return 'A server already lives in that directory - pick another.';
                    }
                    return undefined;
                },
            });
            return answer.trim();
        });
    }

    const serverDir = resolve(cwd(), target);
    if (existsSync(join(serverDir, JAR_NAME))) {
        throw new CliError(
            `A server already exists in ${serverDir}`,
            'Pick a different directory, or run `pnx stop` for the server that is there.',
        );
    }

    if (!askedDir) log.success(`Folder  ${c.muted(serverDir)}`);

    // ── version ──────────────────────────────────────────────────────────────
    const sp = spinner();
    sp.start('Fetching the available versions');
    let releases: Release[];
    try {
        releases = await listReleases();
    } catch (cause) {
        sp.error('Could not reach GitHub');
        throw new CliError(
            `The version list could not load: ${cause instanceof Error ? cause.message : String(cause)}`,
            'Check the connection, or retry in a moment.',
        );
    }
    sp.clear();
    if (releases.length === 0) throw new CliError('No releases are published on GitHub.', 'Try again later.');

    let release: Release;
    if (options.yes && !options.version) {
        release = releases.find((r) => !r.prerelease) ?? releases[0]!;
    } else if (options.version) {
        const wanted = options.version.replace(/^v/, '');
        const found = releases.find((r) => r.tag === options.version || r.version === wanted);
        if (!found) {
            throw new CliError(
                `Version ${options.version} is not in the released list.`,
                'Check the tag (v-prefixed is fine), or drop --version to take the newest.',
            );
        }
        release = found;
    } else {
        release = await promptOr('Which version? Ask for one with --version <tag>.', async () => {
            const tag = await askSelect({
                message: 'Which PowerNukkitX version?',
                options: releases.map((r, index) => ({
                    value: r.tag,
                    label: r.tag,
                    hint: index === 0 ? 'latest' : r.prerelease ? 'pre-release' : undefined,
                })),
                maxItems: 9,
            });
            return releases.find((r) => r.tag === tag) ?? releases[0]!;
        });
    }
    if (options.yes || options.version) {
        log.success(`PowerNukkitX ${c.bold(release.tag)}${release.prerelease ? c.warn(' (pre-release)') : c.muted(release === releases[0] ? '  latest' : '')}`);
    }
    log.message('');

    // ── download ─────────────────────────────────────────────────────────────
    await mkdir(serverDir, { recursive: true });

    const jarPath = join(serverDir, JAR_NAME);
    const bar = await downloadBar(`${c.muted('1/3  ')}Downloading ${JAR_NAME}`, async (update) => {
        await downloadCore(release, jarPath, update);
    });
    if (bar !== true) {
        throw new CliError(`The download stopped: ${bar}`, 'Check the connection. Re-running `pnx init` resumes it.');
    }

    // ── start scripts ────────────────────────────────────────────────────────
    const scripts = officialStartScripts();
    await tasks([
        {
            title: 'Downloading start scripts',
            task: async () => {
                for (const script of scripts) {
                    await downloadFile(script.url, join(serverDir, script.name));
                }
                return `Start scripts written ${c.muted(`(${scripts.map((s) => s.name).join(', ')})`)}`;
            },
        },
        {
            title: 'Registering the server',
            task: async () => {
                await setDefaultServer(serverDir);
                return `Set as the default server ${c.muted('(pnx use changes it)')}`;
            },
        },
    ], { from: 2, total: 3 });

    return { serverDir, release, size: release.assets.find((a) => a.name === JAR_NAME)?.size ?? 0 };
}

/** The create summary, printed the same for `pnx init` and for `pnxcli`. */
export function printCreateSummary(result: CreateResult, options: { close?: boolean } = {}): void {
    if (json.isJson()) {
        json.emit({ serverDir: result.serverDir, version: result.release.tag, size: result.size });
        return;
    }
    const { serverDir, release } = result;
    const name = basename(serverDir);
    const where = relative(cwd(), serverDir);
    const cdTo = where && !where.startsWith('..') ? where : serverDir;

    // the closing card: the exact lines to type next, then the few commands
    // worth knowing - what create-next-app and create-astro both end on
    const first = [
        ...(where !== '' ? [`${c.info('cd')} ${/\s/.test(cdTo) ? `"${cdTo}"` : cdTo}`] : []),
        `${c.info('pnx start')}   ${c.muted('# Ctrl+C saves and stops')}`,
    ];
    log.message('');
    note(first.join('\n'), 'Next steps');
    nextSteps([
        ['pnx status', 'whether it runs, and the address players join'],
        ['pnx plugin install', 'add plugins from the marketplace'],
        ['pnx backup', 'copy the worlds, plugins and settings'],
    ], 'Also useful');
    if (options.close !== false) outroTail(`Created ${c.bold(name)} with PowerNukkitX ${release.tag}`, 'ok');
}
