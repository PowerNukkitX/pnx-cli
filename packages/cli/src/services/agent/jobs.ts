import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Buffer } from 'node:buffer';
import { createBackup, dirSize } from '../backup.js';
import { getInstalled, installPlugin, removeInstalled, updatePlugin } from '../plugins.js';
import { downloadBlob, uploadBlob } from './protocol.js';
import { agentDir, assertWritable, resolveUnder, SandboxError } from './sandbox.js';
import type { Capabilities } from './protocol.js';
import type { Supervisor } from './supervisor.js';
import type { PluginEntry } from '../plugins.js';

/**
 * One command from the hub, carried out on this machine.
 *
 * The hub sends `{ commandId, kind, payload }` and expects a result on the next
 * report. Each kind needs a named capability, checked here as well as at the
 * hub - the hub's check produces an error a person can read, this one holds
 * even when the hub is wrong about what this agent agreed to.
 *
 * Every failure is caught and turned into a result: a command that throws would
 * leave the hub holding a "running" row until it times out, and the person who
 * pressed the button learns nothing for thirty seconds.
 */

const CAPABILITY: Record<string, keyof Capabilities> = {
    backup: 'backups',
    console: 'console',
    control: 'control',
    file: 'files',
    player: 'players',
    plugin: 'plugins',
};

/** Above this a file answer goes up as a blob instead of inline in `output`. */
const INLINE_LIMIT = 64 * 1024;

export interface CommandEnvelope {
    commandId: string;
    kind: string;
    payload: any;
}

export interface CommandContext {
    capabilities: Capabilities;
    serverDir: string;
    supervisor: Supervisor;
    session: any;
}

export interface CommandResult {
    commandId: string;
    ok: boolean;
    detail: string;
    output?: string;
    blobId?: string;
}

const ok = (commandId: string, detail: string, extra: Partial<CommandResult> = {}): CommandResult => ({ commandId, ok: true, detail, ...extra });
const no = (commandId: string, detail: string): CommandResult => ({ commandId, ok: false, detail });

/** Where `pnx backup` writes, so listing it lists the backups. */
function backupsDir(serverDir: string): string {
    return join(serverDir, 'backups');
}

/** Moves something aside instead of destroying it, and says where it went. */
async function toTrash(serverDir: string, target: string): Promise<string> {
    const trash = join(agentDir(serverDir), 'trash');
    await mkdir(trash, { recursive: true });
    const resting = join(trash, `${Date.now()}-${basename(target)}`);
    await rename(target, resting);
    return resting;
}

async function listFiles(serverDir: string, path: string): Promise<{ entries: Array<{ directory: boolean; name: string; bytes?: number; modifiedAt?: string }> }> {
    const dir = resolveUnder(serverDir, path);
    const names = await readdir(dir, { withFileTypes: true });
    const entries: Array<{ directory: boolean; name: string; bytes?: number; modifiedAt?: string }> = [];
    for (const dirent of names) {
        // never offered and never listed: what the hub cannot touch, it does
        // not need to see
        if (dirent.name.startsWith('.pnx-')) continue;
        const entry: { directory: boolean; name: string; bytes?: number; modifiedAt?: string } = {
            directory: dirent.isDirectory(),
            name: dirent.name,
        };
        if (!dirent.isDirectory()) {
            try {
                const info = await stat(join(dir, dirent.name));
                entry.bytes = info.size;
                entry.modifiedAt = info.mtime.toISOString();
            } catch {
                // vanished between the listing and the stat, which happens on a
                // live server; the name is still worth showing
            }
        }
        entries.push(entry);
    }
    entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
    return { entries };
}

async function listBackups(serverDir: string): Promise<{ backups: Array<{ id: string; label: string; bytes: number; createdAt: string }> }> {
    let names;
    try {
        names = await readdir(backupsDir(serverDir), { withFileTypes: true });
    } catch {
        // no backups directory is an empty list, not a failure: it means nobody
        // has taken one yet
        return { backups: [] };
    }
    const backups: Array<{ id: string; label: string; bytes: number; createdAt: string }> = [];
    for (const dirent of names) {
        const full = join(backupsDir(serverDir), dirent.name);
        try {
            const info = await stat(full);
            backups.push({
                bytes: dirent.isDirectory() ? dirSize(full) : info.size,
                createdAt: info.mtime.toISOString(),
                // the file name is the id: it is what delete and download name
                id: dirent.name,
                label: dirent.name,
            });
        } catch {
            // being written right now, most likely; it will be there next time
        }
    }
    backups.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return { backups };
}

async function listPlugins(serverDir: string): Promise<{ plugins: Array<{ name: string; file: string; version?: string; enabled: true }> }> {
    const recorded = await getInstalled();
    // the registry records `fileName` and keys on `slug`; matching on the file
    // is what lets a jar on disk be recognised as something this CLI installed
    const byFile = new Map<string, PluginEntry>();
    for (const plugin of recorded) {
        if (plugin?.fileName) byFile.set(plugin.fileName, plugin);
    }

    let names;
    try {
        names = await readdir(join(serverDir, 'plugins'), { withFileTypes: true });
    } catch {
        return { plugins: [] };
    }

    const plugins: Array<{ name: string; file: string; version?: string; enabled: true }> = [];
    for (const dirent of names) {
        if (!dirent.isFile() || !dirent.name.toLowerCase().endsWith('.jar')) continue;
        const known = byFile.get(dirent.name);
        plugins.push({
            // presence is what a listing can honestly report; whether the
            // server actually loaded the jar is a thing only the server knows
            enabled: true,
            file: dirent.name,
            name: known?.name ?? dirent.name.replace(/\.jar$/i, ''),
            ...(known?.version ? { version: known.version } : {}),
        });
    }
    plugins.sort((a, b) => a.name.localeCompare(b.name));
    return { plugins };
}

/** The player list, from the server itself rather than from anything guessed. */
async function listPlayers(supervisor: Supervisor): Promise<{ ok: false; detail: string } | { ok: true; value: { players: Array<{ name: string }> } }> {
    const probe = await supervisor.probePlayers();
    if (!probe.ok) return { ok: false, detail: probe.detail };
    const snapshot = supervisor.snapshot();
    return { ok: true, value: { players: snapshot.playerNames.map((name) => ({ name })) } };
}

async function runFile(scope: CommandContext & CommandEnvelope): Promise<CommandResult> {
    const { commandId, payload, serverDir, session } = scope;
    const op: string = payload.op;

    if (op === 'list') {
        return ok(commandId, 'listed', { output: JSON.stringify(await listFiles(serverDir, payload.path)) });
    }
    if (op === 'mkdir') {
        await mkdir(assertWritable(resolveUnder(serverDir, payload.path)), { recursive: true });
        return ok(commandId, 'created');
    }
    if (op === 'delete') {
        // moved aside rather than removed: a delete arriving over a web session
        // is one somebody can regret, and the disk has room for regret
        const target = assertWritable(resolveUnder(serverDir, payload.path));
        const resting = await toTrash(serverDir, target);
        return ok(commandId, `moved to ${resting.replace(serverDir, '.')}`);
    }
    if (op === 'read' || op === 'download') {
        const target = resolveUnder(serverDir, payload.path);
        const info = await stat(target);
        if (info.isDirectory()) return no(commandId, 'that is a directory');

        // small enough to read in a panel goes inline; larger becomes a
        // transfer, and transfers are what blobs are for
        if (op === 'read' && info.size <= INLINE_LIMIT) {
            return ok(commandId, 'read', { output: await readFile(target, 'utf8') });
        }
        const blobId = await uploadBlob(session, new Uint8Array(await readFile(target)));
        return ok(commandId, `sent ${info.size} bytes`, { blobId });
    }
    if (op === 'write') {
        const target = assertWritable(resolveUnder(serverDir, payload.path));
        const bytes = await downloadBlob(session, payload.blobId);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes);
        return ok(commandId, `wrote ${bytes.byteLength} bytes`);
    }
    return no(commandId, `this agent does not implement file:${op}`);
}

async function runPlugin(scope: CommandContext & CommandEnvelope): Promise<CommandResult> {
    const { commandId, payload, serverDir } = scope;
    const dir = join(serverDir, 'plugins');
    const op: string = payload.op;

    if (op === 'list') {
        return ok(commandId, 'listed', { output: JSON.stringify(await listPlugins(serverDir)) });
    }
    if (op === 'install') {
        const entry = await installPlugin(payload.slug, dir, () => {});
        return ok(commandId, `${entry.name} ${entry.version} installed; restart to load it`);
    }
    if (op === 'update') {
        const entry = await updatePlugin(payload.slug, dir, undefined, undefined, () => {});
        return ok(commandId, `${entry?.name ?? payload.slug} updated; restart to load it`);
    }
    if (op === 'remove') {
        // the hub names a plugin the way the listing named it - the display
        // name, or the file name - while the registry keys on a slug. The
        // lookup is what turns one into the other.
        const recorded = await getInstalled();
        const record = recorded.find((plugin) => plugin?.name === payload.name || plugin?.fileName === payload.name);
        const file = record?.fileName ?? `${payload.name}.jar`;
        const target = resolveUnder(serverDir, join('plugins', file));
        const resting = await toTrash(serverDir, target);
        if (record?.slug) await removeInstalled(record.slug);
        return ok(commandId, `moved to ${resting.replace(serverDir, '.')}; restart to unload it`);
    }
    return no(commandId, `this agent does not implement plugin:${op}`);
}

async function runBackup(scope: CommandContext & CommandEnvelope): Promise<CommandResult> {
    const { commandId, payload, serverDir, session } = scope;
    const op: string = payload.op;

    if (op === 'list') {
        return ok(commandId, 'listed', { output: JSON.stringify(await listBackups(serverDir)) });
    }
    if (op === 'create') {
        const made = await createBackup(serverDir);
        return ok(commandId, `created ${basename(made.path)} (${made.size} bytes)`);
    }
    if (op === 'delete') {
        const target = resolveUnder(serverDir, join('backups', payload.backupId));
        await rm(target, { force: true, recursive: true });
        return ok(commandId, 'deleted');
    }
    if (op === 'download') {
        const target = resolveUnder(serverDir, join('backups', payload.backupId));
        const info = await stat(target);
        if (info.isDirectory()) return no(commandId, 'that backup is a directory; archive it first');
        const blobId = await uploadBlob(session, new Uint8Array(await readFile(target)), 'application/zip');
        return ok(commandId, `sent ${info.size} bytes`, { blobId });
    }
    // restoring is refused, deliberately: it means replacing a running
    // server's files, and doing that safely needs the server stopped, the
    // current state kept, and a way back - none of which this agent can promise
    if (op === 'restore') {
        return no(commandId, 'restoring is not implemented here; stop the server and unpack the archive by hand');
    }
    return no(commandId, `this agent does not implement backup:${op}`);
}

/** A player action, as one console line. */
async function runPlayer(scope: CommandContext & CommandEnvelope): Promise<CommandResult> {
    const { commandId, payload, supervisor } = scope;
    if (payload.op === 'list') {
        const listed = await listPlayers(supervisor);
        return listed.ok
            ? ok(commandId, 'listed', { output: JSON.stringify(listed.value) })
            : no(commandId, listed.detail);
    }

    const build: Record<string, () => string> = {
        ban: () => `ban ${payload.name}${payload.reason ? ` ${payload.reason}` : ''}`,
        deop: () => `deop ${payload.name}`,
        kick: () => `kick ${payload.name}${payload.reason ? ` ${payload.reason}` : ''}`,
        op: () => `op ${payload.name}`,
        pardon: () => `pardon ${payload.name}`,
        whitelist: () => `whitelist ${payload.allow ? 'add' : 'remove'} ${payload.name}`,
    };
    const line = build[payload.op];
    if (!line) return no(commandId, `this agent does not implement player:${payload.op}`);

    const sent = supervisor.sendConsole(line());
    return sent.ok ? ok(commandId, sent.detail) : no(commandId, sent.detail);
}

async function runControl(scope: CommandContext & CommandEnvelope): Promise<CommandResult> {
    const { commandId, payload, supervisor } = scope;
    const actions: Record<string, () => Promise<{ ok: boolean; detail: string }>> = {
        restart: () => supervisor.restart(),
        start: () => supervisor.start(),
        stop: () => supervisor.stop(),
    };
    const action = actions[payload.action];
    if (!action) return no(commandId, `unknown control action ${payload.action}`);
    const result = await action();
    return result.ok ? ok(commandId, result.detail) : no(commandId, result.detail);
}

export async function runCommand(context: CommandContext, command: CommandEnvelope): Promise<CommandResult> {
    const { commandId, kind, payload } = command;
    const needed = CAPABILITY[kind];

    if (!needed) return no(commandId, `this agent does not implement ${kind}`);
    if (context.capabilities[needed] !== true) {
        return no(commandId, `${needed} is off in this agent's configuration`);
    }

    const scope: CommandContext & CommandEnvelope = { ...context, ...command };

    try {
        switch (kind) {
            case 'backup':
                return await runBackup(scope);
            case 'console': {
                const sent = context.supervisor.sendConsole(payload.line);
                return sent.ok ? ok(commandId, sent.detail) : no(commandId, sent.detail);
            }
            case 'control':
                return await runControl(scope);
            case 'file':
                return await runFile(scope);
            case 'player':
                return await runPlayer(scope);
            case 'plugin':
                return await runPlugin(scope);
            default:
                return no(commandId, `this agent does not implement ${kind}`);
        }
    } catch (failure) {
        // a refused path is the operator's answer, not an internal error, so it
        // reads as the sentence the sandbox wrote
        if (failure instanceof SandboxError) return no(commandId, failure.message);
        return no(commandId, failure instanceof Error ? failure.message : String(failure));
    }
}
