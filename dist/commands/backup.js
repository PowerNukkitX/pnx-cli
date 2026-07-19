import { defineCommand } from 'citty';
import { intro, outro, log, spin } from '../ui/output.js';
import { resolveServerDir } from '../services/server.js';
import { createBackup, dirSize, fmtSize } from '../services/backup.js';
export async function runBackup() {
    intro(`💾 ${"Backup"}`);
    const serverPath = await resolveServerDir();
    if (!serverPath) {
        log.error("No server detected");
        process.exit(1);
    }
    const sp = spin("Collecting files...");
    sp.stop(`Estimated size: ${fmtSize(dirSize(serverPath))}`);
    const sp2 = spin("Copying files...");
    const { path, size } = await createBackup(serverPath);
    sp2.stop(`Backup created: ${path} (${fmtSize(size)})`);
    outro(`Backup created: ${path} (${fmtSize(size)})`);
}
export const backupCmd = defineCommand({
    meta: { description: 'Create a server backup' },
    args: {},
    run: () => runBackup(),
});
