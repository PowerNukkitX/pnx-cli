import { type RunContext, CliError } from '../cli/define.js';
import { introHead, nextSteps, note, outroTail } from '../ui/kit.js';
import { c, S } from '../ui/theme.js';
import { resolveServerDir } from '../services/server.js';
import { findLeaf, leaves, openConfig, setLeaf, type ConfigFile, type Leaf } from '../services/config-file.js';
import { isAlive, loadPid } from '../services/process.js';
import { json } from '../infra/json.js';
import { nearest } from '../cli/define.js';

/**
 * The configuration the server actually runs on.
 *
 * Two files can hold it - `pnx.yml` first, the old `server.properties` second.
 * `pnx config` shows it the way it is written (keys quiet, comments quiet, only
 * switches coloured); `get` and `set` reach one value by its dotted key, so a
 * script can change the port without a YAML library and without losing a
 * single comment.
 */

function colorVal(value: string): string {
    if (value === 'true' || value === 'on') return c.success(value);
    if (value === 'false' || value === 'off') return c.muted(value);
    return value;
}

async function requireConfig(): Promise<ConfigFile> {
    const serverPath = await resolveServerDir();
    if (!serverPath) {
        throw new CliError('No server found here.', 'Create one with `pnx init`, or point at one with `pnx use <path>`.');
    }
    const file = openConfig(serverPath);
    if (!file) {
        throw new CliError(
            `Neither pnx.yml nor server.properties is in ${serverPath}.`,
            'Both are written the first time the server boots: run `pnx start` once.',
        );
    }
    return file;
}

function requireLeaf(file: ConfigFile, key: string): Leaf {
    const leaf = findLeaf(file, key);
    if (Array.isArray(leaf)) {
        throw new CliError(
            `\`${key}\` is ambiguous: ${leaf.map((entry) => entry.key).join(', ')}.`,
            'Write the full dotted key.',
        );
    }
    if (!leaf) {
        const keys = leaves(file).map((entry) => entry.key);
        const tail = nearest(key, keys.map((entry) => entry.split('.').pop()!));
        const guess = nearest(key, keys) ?? (tail ? keys.find((entry) => entry.endsWith(`.${tail}`) || entry === tail) ?? null : null);
        throw new CliError(
            `No key \`${key}\` in ${file.path}.`,
            guess ? `Did you mean \`${guess}\`? \`pnx config\` lists them all.` : '`pnx config` lists them all.',
        );
    }
    return leaf;
}

export async function runConfig(): Promise<void> {
    const file = await requireConfig().catch((cause) => {
        if (json.isJson()) throw cause;
        introHead('pnx config', 'what the server reads at boot');
        nextSteps([['pnx init', 'create one'], ['pnx use <path>', 'point at an existing one'], ['pnx start', 'write the file on first boot']], 'Try');
        outroTail(cause instanceof Error ? cause.message : String(cause), 'fail');
        return null;
    });
    if (!file) return;

    if (json.isJson()) {
        json.emit({ path: file.path, values: Object.fromEntries(leaves(file).map((leaf) => [leaf.key, leaf.value])) });
        return;
    }

    introHead('pnx config', 'what the server reads at boot');
    const sep = file.kind === 'yml' ? ':' : '=';
    const body = file.text
        .split(/\r?\n/)
        .map((line) => {
            const trimmed = line.trim();
            if (!trimmed) return '';
            if (trimmed.startsWith('#')) return c.muted(trimmed);
            const index = trimmed.indexOf(sep);
            if (index <= 0) return c.muted(trimmed);
            const key = trimmed.slice(0, index);
            const indent = line.match(/^(\s*)/)?.[1] ?? '';
            const rest = trimmed.slice(index + 1);
            const lead = rest.match(/^\s*/)?.[0] ?? '';
            const value = rest.trim();
            return `${indent}${c.muted(key)}${c.muted(sep)}${lead}${value ? colorVal(value) : ''}`;
        })
        .filter((line, index, all) => line !== '' || index < all.length - 1);

    note(body.join('\n'), file.path);
    nextSteps([
        ['pnx config get settings.port', 'read one value'],
        ['pnx config set settings.motd "My server"', 'change one value, comments kept'],
    ]);
    outroTail('Restart the server after a change.');
}

export async function configGetCommand(ctx: RunContext): Promise<void> {
    const key = ctx.args.positionals[0]!;
    const file = await requireConfig();
    const leaf = requireLeaf(file, key);
    if (json.isJson()) json.emit({ key: leaf.key, value: leaf.value, file: file.path });
    else process.stdout.write(`${leaf.value}\n`);
}

export async function configSetCommand(ctx: RunContext): Promise<void> {
    const [key, ...words] = ctx.args.positionals;
    const value = words.join(' ');
    const file = await requireConfig();
    const leaf = requireLeaf(file, key!);
    if (leaf.value === value) {
        if (json.isJson()) json.emit({ key: leaf.key, value, changed: false });
        else outroTail(`${leaf.key} is already ${c.bold(value)}.`);
        return;
    }
    const before = setLeaf(file, leaf, value);
    if (json.isJson()) {
        json.emit({ key: leaf.key, from: before, to: value, changed: true, file: file.path });
        return;
    }
    process.stdout.write(`${c.success(S.check)} ${leaf.key}  ${c.muted(before || '""')} ${c.muted(S.arrow)} ${c.bold(value)}\n`);
    const record = await loadPid();
    if (record && isAlive(record.pid)) {
        process.stdout.write(`  ${c.muted('The server is running: restart it to apply (pnx stop, then pnx start).')}\n`);
    }
}

export function configCommand(ctx: RunContext): Promise<void> {
    void ctx;
    return runConfig();
}
