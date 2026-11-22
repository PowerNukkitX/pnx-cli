import { rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { join } from 'node:path';
import { readBool, type RunContext } from '../cli/define.js';
import { downloadBar, introHead, nextSteps, outroTail, spinner, empty } from '../ui/kit.js';
import { resolveServerDir } from '../services/server.js';
import { getLatestRelease, downloadCore } from '../services/release.js';
import { JAR_NAME } from '../infra/paths.js';
import { isAlive, loadPid } from '../services/process.js';

/**
 * Updating PowerNukkitX itself.
 *
 * The API answers with the newest release, not with whether it is newer than
 * the jar on disk - so this says what it actually knows, keeps the current
 * build beside the new one under `.old`, and borrows the create flow's
 * download bar, which already knows how to fail kindly.
 */

export interface UpdateOptions {
    force?: boolean;
}

export async function runUpdate(options: UpdateOptions): Promise<void> {
    introHead('pnx update');

    const serverPath = await resolveServerDir();
    if (!serverPath) {
        empty('No server found here.', [
            ['pnx init', 'create one'],
            ['pnx use <path>', 'point at an existing one'],
        ]);
        outroTail('Nothing to update.', 'fail');
        return;
    }

    const running = await loadPid();
    if (running && isAlive(running.pid) && resolve(running.serverPath) === resolve(serverPath)) {
        nextSteps([['pnx stop', 'stop it first, then run pnx update again']], 'Do');
        outroTail('The server is running; its jar cannot be replaced now.', 'fail');
        return;
    }

    const sp = spinner();
    sp.start('Checking for a newer build...');
    let release;
    try {
        release = await getLatestRelease(options.force === true);
    } catch (cause) {
        sp.error('Could not reach GitHub');
        nextSteps([[cause instanceof Error ? cause.message : String(cause), 'why it failed']], 'Why');
        outroTail('Nothing was downloaded.', 'fail');
        return;
    }
    sp.stop(`Latest release is ${release.tag}`);

    // download beside the current jar, and swap only once the file is whole:
    // a dropped connection must never leave the server without a jar
    const jarPath = join(serverPath, JAR_NAME);
    const partPath = `${jarPath}.download`;
    const bar = await downloadBar(`Downloading ${JAR_NAME}`, async (update) => {
        await downloadCore(release!, partPath, update);
    });
    if (bar !== true) {
        await rm(partPath, { force: true });
        nextSteps([['pnx update', 'retry - the current jar was not touched']], 'Retry');
        outroTail(`The download failed: ${bar}`, 'fail');
        return;
    }
    try {
        await rename(jarPath, `${jarPath}.old`);
    } catch {
        // no previous jar to keep - the new one simply takes its place
    }
    await rename(partPath, jarPath);

    nextSteps([
        [`pnx start`, 'boot it on the new build'],
        [`${JAR_NAME}.old`, 'the previous build, kept in case you need to go back'],
    ]);
    outroTail(`PowerNukkitX is now ${release.tag}.`, 'ok');
}

export async function updateCommand(ctx: RunContext): Promise<void> {
    await runUpdate({ force: readBool(ctx.args, 'force') });
}
