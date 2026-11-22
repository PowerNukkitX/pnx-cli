import { readdirSync, statSync } from 'node:fs';
import { mkdir, cp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** Directories that are never part of a backup: logs regenerate, caches rot. */
const IGNORE = new Set(['logs', 'cache', 'crash-reports', 'backups', '.git', '.pnx-agent']);

/** Total size of a tree, best effort. Unreadable entries count as nothing. */
export function dirSize(dir: string): number {
    let total = 0;
    try {
        for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            const info = statSync(full);
            total += info.isDirectory() ? dirSize(full) : info.size;
        }
    } catch {
        // vanished mid-scan, or unreadable: the number is a promise about
        // magnitude, not an invoice
    }
    return total;
}

/** Bytes, read like a person reads them. */
export function fmtSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Size of what a backup would copy: the server minus what backups skip. */
export function backupableSize(serverDir: string): number {
    let total = 0;
    try {
        for (const entry of readdirSync(serverDir)) {
            if (IGNORE.has(entry) || entry.startsWith('.')) continue;
            const full = join(serverDir, entry);
            const info = statSync(full);
            total += info.isDirectory() ? dirSize(full) : info.size;
        }
    } catch {
        // best effort, as dirSize
    }
    return total;
}

/** Copies the whole server (minus ignored dirs) into backups/<timestamp>/. */
export async function createBackup(serverDir: string): Promise<{ path: string; size: number }> {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const destDir = join(serverDir, 'backups', `pnx-backup-${ts}`);
    await mkdir(destDir, { recursive: true });
    for (const entry of await readdir(serverDir)) {
        if (IGNORE.has(entry) || entry.startsWith('.')) continue;
        await cp(join(serverDir, entry), join(destDir, entry), { recursive: true, force: true });
    }
    return { path: destDir, size: dirSize(destDir) };
}

export interface BackupEntry {
    name: string;
    path: string;
    /** when it was taken, read from the folder name (mtime as a fallback) */
    date: Date;
    size: number;
}

/** Every backup under `backups/`, newest first. */
export async function listBackups(serverDir: string, withSize = true): Promise<BackupEntry[]> {
    const root = join(serverDir, 'backups');
    let names: string[];
    try {
        names = await readdir(root);
    } catch {
        return [];
    }
    const entries: BackupEntry[] = [];
    for (const name of names) {
        const path = join(root, name);
        let info;
        try {
            info = statSync(path);
        } catch {
            continue;
        }
        if (!info.isDirectory()) continue;
        const stamp = name.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
        const date = stamp ? new Date(`${stamp[1]}T${stamp[2]}:${stamp[3]}:${stamp[4]}Z`) : info.mtime;
        entries.push({ name, path, date: Number.isNaN(date.getTime()) ? info.mtime : date, size: withSize ? dirSize(path) : 0 });
    }
    return entries.sort((a, b) => b.date.getTime() - a.date.getTime());
}

/** Deletes all but the `keep` newest backups; returns what was removed. */
export async function pruneBackups(serverDir: string, keep: number): Promise<BackupEntry[]> {
    const all = await listBackups(serverDir, false);
    const doomed = all.slice(Math.max(0, keep));
    for (const entry of doomed) await rm(entry.path, { recursive: true, force: true });
    return doomed;
}

/**
 * Puts a backup back in place. What the backup holds replaces the live copy
 * entry by entry; a fresh safety backup of the current state is taken first,
 * so a restore is itself undoable.
 */
export async function restoreBackup(serverDir: string, backup: BackupEntry): Promise<{ safety: string }> {
    const safety = await createBackup(serverDir);
    for (const entry of await readdir(backup.path)) {
        const target = join(serverDir, entry);
        await rm(target, { recursive: true, force: true });
        await cp(join(backup.path, entry), target, { recursive: true, force: true });
    }
    return { safety: safety.path };
}

/** "3 min ago", "2 days ago" - how people say when. */
export function ago(date: Date, now = Date.now()): string {
    const seconds = Math.max(0, Math.round((now - date.getTime()) / 1000));
    if (seconds < 60) return 'just now';
    const units: Array<[number, string]> = [[86400 * 30, 'month'], [86400 * 7, 'week'], [86400, 'day'], [3600, 'h'], [60, 'min']];
    for (const [size, unit] of units) {
        if (seconds >= size) {
            const count = Math.floor(seconds / size);
            return unit.length <= 3 ? `${count} ${unit} ago` : `${count} ${unit}${count > 1 ? 's' : ''} ago`;
        }
    }
    return 'just now';
}
