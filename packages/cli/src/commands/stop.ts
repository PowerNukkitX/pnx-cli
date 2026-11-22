import { readBool, type RunContext } from '../cli/define.js';
import { introHead, nextSteps, outroTail, spinner } from '../ui/kit.js';
import { clearPid, isAlive, killProcess, loadPid, requestStop, waitForExit } from '../services/process.js';

/**
 * Stopping the server the PID record points at - the way its owner would.
 *
 * `stop` goes to the server console (through `pnx start`'s control socket), so
 * the world is saved and players see a message. Only `--force` kills, because
 * a killed server loses whatever it had not written yet.
 */

const STOP_TIMEOUT_MS = 60_000;

export async function runStop(options: { force?: boolean } = {}): Promise<void> {
    const record = await loadPid();
    if (!record || !isAlive(record.pid)) {
        await clearPid();
        process.stdout.write('No server is running.\n');
        return;
    }
    introHead('pnx stop');

    const sp = spinner();
    if (options.force) {
        sp.start(`Killing PID ${record.pid}`);
        await killProcess(record.pid);
        await waitForExit(record.pid, 5000);
        await clearPid();
        sp.stop(`Killed PID ${record.pid}`);
        outroTail('Server killed - anything not yet saved is lost.', 'ok');
        return;
    }

    sp.start(`Stopping the server (PID ${record.pid})`);
    const how = await requestStop(record);
    if (how === 'none') {
        sp.error('This server cannot be asked to stop politely');
        nextSteps([['pnx stop --force', 'kill it (unsaved progress is lost)']], 'Try');
        outroTail('It was not started by `pnx start`, so there is no console to type `stop` on.', 'fail');
        return;
    }
    const gone = await waitForExit(record.pid, STOP_TIMEOUT_MS, (elapsed) => {
        sp.message(`Saving the world and stopping (${Math.round(elapsed / 1000)} s)`);
    });
    if (!gone) {
        sp.error(`Still running after ${STOP_TIMEOUT_MS / 1000} s`);
        nextSteps([['pnx stop --force', 'kill it (unsaved progress is lost)']], 'Try');
        outroTail('The server did not stop.', 'fail');
        return;
    }
    await clearPid();
    sp.stop(how === 'console' ? 'World saved, server stopped' : 'Server stopped');
}

export async function stopCommand(ctx: RunContext): Promise<void> {
    await runStop({ force: readBool(ctx.args, 'force') });
}
