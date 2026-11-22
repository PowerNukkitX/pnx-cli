import { resolve } from 'node:path';
import { CliError, readString, readBool, type RunContext } from '../cli/define.js';
import { askConfirm, askSelect, empty, introHead, isInteractive, nextSteps, outroTail, tasks, note, table } from '../ui/kit.js';
import { c } from '../ui/theme.js';
import { resolveServerDir } from '../services/server.js';
import { ago, backupableSize, createBackup, fmtSize, listBackups, pruneBackups, restoreBackup, type BackupEntry } from '../services/backup.js';
import { isAlive, loadPid } from '../services/process.js';
import { json } from '../infra/json.js';

/**
 * Backups as a lifecycle: take one, see them, put one back, keep only the
 * newest few. Every stage is shown as a stage, and a restore always takes a
 * safety copy first, so no command here is a one-way door.
 */

async function requireServer(): Promise<string> {
    const serverPath = await resolveServerDir();
    if (!serverPath) throw new CliError('No server found here.', 'Point at one with `pnx use <path>`, or create one with `pnx init`.');
    return serverPath;
}

function parseKeep(text: string | undefined): number | null {
    if (text === undefined) return null;
    const keep = Number.parseInt(text, 10);
    if (!Number.isInteger(keep) || keep < 1 || String(keep) !== text.trim()) {
        throw new CliError(`\`--keep ${text}\` is not a count.`, 'Write a whole number of backups to keep, e.g. --keep 5.');
    }
    return keep;
}

export async function runBackup(options: { keep?: string } = {}): Promise<void> {
    const keep = parseKeep(options.keep);
    if (!json.isJson()) introHead('pnx backup', 'archive the world as it lies');

    const serverPath = await resolveServerDir();
    if (!serverPath) {
        if (json.isJson()) throw new CliError('No server found here.');
        note(c.warn('No server found here.'));
        nextSteps([['pnx use <path>', 'point at a server'], ['pnx init', 'create one first']], 'Try');
        outroTail('Nothing was copied.', 'fail');
        return;
    }

    const holder: { made: { path: string; size: number } | null } = { made: null };
    await tasks([
        { title: 'Measuring the server directory', task: () => `about ${fmtSize(backupableSize(serverPath))} to copy` },
        {
            title: 'Copying files',
            task: async () => {
                holder.made = await createBackup(serverPath);
                return `copied ${fmtSize(holder.made.size)}`;
            },
        },
    ]);

    const made = holder.made;
    if (!made) {
        outroTail('The backup did not complete.', 'fail');
        return;
    }
    const pruned = keep ? await pruneBackups(serverPath, keep) : [];

    if (json.isJson()) {
        json.emit({ path: made.path, size: made.size, pruned: pruned.map((entry) => entry.path) });
        return;
    }

    note(`${c.muted('Location')}  ${made.path}\n${c.muted('Size')}      ${fmtSize(made.size)}`, 'Backup created');
    if (pruned.length > 0) {
        note(c.muted(pruned.map((entry) => entry.name).join('\n')), `Removed ${pruned.length} older backup${pruned.length > 1 ? 's' : ''} (keeping ${keep})`);
    }
    nextSteps([['pnx backup list', 'see every backup'], ['pnx backup restore', 'put one back']]);
    outroTail('Keep a copy somewhere other than this machine.');
}

export async function backupListCommand(): Promise<void> {
    const serverPath = await requireServer();
    const all = await listBackups(serverPath);
    if (json.isJson()) {
        json.emit(all.map((entry) => ({ name: entry.name, path: entry.path, date: entry.date.toISOString(), size: entry.size })));
        return;
    }
    introHead('pnx backup list', serverPath);
    if (all.length === 0) {
        empty('No backups yet.', [['pnx backup', 'take the first one']]);
        outroTail();
        return;
    }
    const total = all.reduce((sum, entry) => sum + entry.size, 0);
    table(
        ['#', 'Taken', 'When', 'Size', 'Name'],
        all.map((entry, index) => [
            c.muted(String(index + 1)),
            entry.date.toLocaleString(),
            c.muted(ago(entry.date)),
            fmtSize(entry.size),
            c.muted(entry.name),
        ]),
    );
    nextSteps([['pnx backup restore <#|name>', 'put one back'], ['pnx backup prune --keep 5', 'free some space']]);
    outroTail(`${all.length} backup${all.length > 1 ? 's' : ''}, ${fmtSize(total)} in all.`);
}

function pick(all: BackupEntry[], which: string): BackupEntry {
    if (which === 'latest' || which === 'last') return all[0]!;
    const index = Number.parseInt(which, 10);
    if (String(index) === which && index >= 1 && index <= all.length) return all[index - 1]!;
    const match = all.find((entry) => entry.name === which || resolve(entry.path) === resolve(which));
    if (!match) throw new CliError(`No backup \`${which}\`.`, 'Run `pnx backup list` for the numbers and names.');
    return match;
}

export async function backupRestoreCommand(ctx: RunContext): Promise<void> {
    const serverPath = await requireServer();
    const record = await loadPid();
    if (record && isAlive(record.pid) && resolve(record.serverPath) === resolve(serverPath)) {
        throw new CliError('The server is running: restoring now would corrupt the world.', 'Stop it with `pnx stop`, then try again.');
    }
    const all = await listBackups(serverPath, false);
    if (all.length === 0) throw new CliError('There is no backup to restore.', 'Take one with `pnx backup`.');

    const which = ctx.args.positionals[0];
    let chosen: BackupEntry;
    if (which) {
        chosen = pick(all, which);
    } else if (isInteractive() && !json.isJson()) {
        chosen = await askSelect({
            message: 'Which backup?',
            options: all.map((entry) => ({ value: entry, label: entry.date.toLocaleString(), hint: ago(entry.date) })),
        });
    } else {
        throw new CliError('Say which backup to restore.', 'Example: `pnx backup restore latest` (or a number from `pnx backup list`).');
    }

    if (!json.isJson()) introHead('pnx backup restore', chosen.name);
    if (!readBool(ctx.args, 'yes')) {
        if (!isInteractive() || json.isJson()) throw new CliError('A restore replaces the live files.', 'Add --yes to confirm in a script.');
        const ok = await askConfirm(`Replace the server's files with the backup from ${ago(chosen.date)}? A safety copy is taken first.`, false);
        if (!ok) {
            outroTail('Nothing was changed.');
            return;
        }
    }

    const holder = { safety: '' };
    await tasks([{
        title: 'Taking a safety copy, then restoring',
        task: async () => {
            holder.safety = (await restoreBackup(serverPath, chosen)).safety;
            return `Restored ${chosen.name}`;
        },
    }]);
    if (json.isJson()) {
        json.emit({ restored: chosen.path, safety: holder.safety });
        return;
    }
    note(c.muted(holder.safety), 'The state before the restore is kept in');
    nextSteps([['pnx start', 'boot the restored server']]);
    outroTail('Restored.', 'ok');
}

export async function backupPruneCommand(ctx: RunContext): Promise<void> {
    const keep = parseKeep(readString(ctx.args, 'keep')) ?? 5;
    const serverPath = await requireServer();
    const removed = await pruneBackups(serverPath, keep);
    if (json.isJson()) {
        json.emit({ keep, removed: removed.map((entry) => entry.path) });
        return;
    }
    introHead('pnx backup prune', `keep the ${keep} newest`);
    if (removed.length > 0) note(c.muted(removed.map((entry) => entry.name).join('\n')), 'Removed');
    outroTail(
        removed.length ? `Removed ${removed.length}, kept ${keep}.` : `Nothing to remove: ${keep} or fewer backups.`,
        removed.length ? 'ok' : 'info',
    );
}

export function backupCommand(ctx: RunContext): Promise<void> {
    return runBackup({ keep: readString(ctx.args, 'keep') });
}
