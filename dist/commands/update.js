import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { defineCommand } from 'citty';
import { intro, outro, log, spin, progress } from '../ui/output.js';
import { resolveServerDir } from '../services/server.js';
import { getLatestRelease, downloadCore } from '../services/release.js';
import { JAR_NAME } from '../infra/paths.js';
export async function runUpdate(force = false) {
    intro(`🔄 ${"Update PowerNukkitX"}`);
    const serverPath = await resolveServerDir();
    if (!serverPath) {
        log.error("No server found");
        process.exit(1);
    }
    const sp = spin("Checking for updates...");
    const release = await getLatestRelease(force);
    sp.stop(`New version available: ${release.tag}`);
    const jarPath = join(serverPath, JAR_NAME);
    log.step("Backing up old version...");
    await rename(jarPath, `${jarPath}.old`).catch(() => { });
    log.step("Downloading...");
    await downloadCore(release, jarPath, pct => progress(pct, JAR_NAME));
    log.success("Update complete!");
    log.info("Restart the server to apply changes");
    outro("Update complete!");
}
export const updateCmd = defineCommand({
    meta: { description: 'Update PowerNukkitX to the latest version' },
    args: {
        force: { type: 'boolean', description: 'Force update', default: false },
        dev: { type: 'boolean', description: 'Dev version', default: false },
    },
    run: ({ args }) => runUpdate(args.force),
});
