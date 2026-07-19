import { readdirSync, statSync } from 'node:fs';
import { mkdir, cp, readdir } from 'node:fs/promises';
import { join } from 'node:path';
const IGNORE = new Set(['logs', 'cache', 'crash-reports', 'backups', '.git']);
export function dirSize(dir) {
    let total = 0;
    try {
        for (const f of readdirSync(dir)) {
            const full = join(dir, f);
            const s = statSync(full);
            total += s.isDirectory() ? dirSize(full) : s.size;
        }
    }
    catch { }
    return total;
}
export function fmtSize(b) {
    if (b < 1024)
        return `${b} B`;
    if (b < 1024 ** 2)
        return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
export async function createBackup(serverDir) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const destDir = join(serverDir, 'backups', `pnx-backup-${ts}`);
    await mkdir(destDir, { recursive: true });
    for (const item of await readdir(serverDir)) {
        if (IGNORE.has(item) || item.startsWith('.'))
            continue;
        await cp(join(serverDir, item), join(destDir, item), { recursive: true, force: true });
    }
    return { path: destDir, size: dirSize(destDir) };
}
