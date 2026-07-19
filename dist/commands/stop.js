import { defineCommand } from 'citty';
import { intro, outro, log, spin } from '../ui/output.js';
import { loadPid, clearPid, killProcess, isAlive } from '../services/process.js';
export async function runStop() {
    intro(`⏹ ${"Stop server"}`);
    const pid = await loadPid();
    if (!pid || !isAlive(pid.pid)) {
        log.warn("No server running");
        await clearPid();
        return;
    }
    const sp = spin(`Stopping server (PID ${String(pid.pid)})...`);
    const ok = await killProcess(pid.pid);
    await clearPid();
    if (ok) {
        sp.stop("Server stopped");
        outro("Server stopped");
    }
    else
        sp.fail("Failed to stop");
}
export const stopCmd = defineCommand({
    meta: { description: 'Stop the running PowerNukkitX server' },
    args: {},
    run: () => runStop(),
});
