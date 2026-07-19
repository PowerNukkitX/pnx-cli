import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';
import { spawn } from 'node:child_process';
import { defineCommand } from 'citty';
import { intro, outro, log, spin } from '../ui/output.js';
import { promptConfirm } from '../ui/prompts.js';
import { resolveServerDir, checkJava, findJava, buildLaunchArgs, javaEnv } from '../services/server.js';
import { savePid } from '../services/process.js';
import { JAR_NAME } from '../infra/paths.js';
export async function runStart(opts) {
    const serverPath = opts.dir
        ? (opts.dir.includes(':') || opts.dir.startsWith('/') ? opts.dir : join(cwd(), opts.dir))
        : (await resolveServerDir()) ?? cwd();
    if (!existsSync(join(serverPath, JAR_NAME))) {
        log.warn("No server found here");
        if (!(await promptConfirm("Create a server now?", true)))
            process.exit(0);
        const { initCmd } = await import('./init.js');
        await initCmd.run({ args: { dir: serverPath } });
        return;
    }
    intro(`🚀 ${"Start server"}`);
    const sp = spin("Checking Java...");
    const java = await checkJava();
    if (!java.ok) {
        sp.fail("Java 21+ required — https://adoptium.net/");
        process.exit(1);
    }
    sp.stop(`Java ${String(java.version)} detected`);
    const mem = opts.memory ?? '2G';
    const cmdArgs = buildLaunchArgs(mem);
    const javaExe = findJava();
    if (opts.dryRun) {
        log.info(`${javaExe} ${cmdArgs.join(' ')}`);
        outro("Command generated");
        return;
    }
    log.step(`${"Starting..."} (memory: ${mem})`);
    const run = () => {
        const child = spawn(javaExe, cmdArgs, { stdio: 'inherit', env: javaEnv(), cwd: serverPath });
        if (child.pid)
            savePid(child.pid, serverPath);
        log.success(`Server running (PID ${String(child.pid)})`);
        child.on('exit', code => {
            if (code !== 0 && opts.restart) {
                log.warn("Restarting...");
                run();
            }
            else {
                log.info(`Server stopped (code ${String(code ?? '?')})`);
                process.exit(code ?? 0);
            }
        });
    };
    run();
}
export const startCmd = defineCommand({
    meta: { description: 'Start the PowerNukkitX server' },
    args: {
        dir: { type: 'string', description: 'Server directory' },
        memory: { type: 'string', description: 'Memory (e.g. 2G)', default: '2G' },
        restart: { type: 'boolean', description: 'Auto-restart on crash', default: false },
        'dry-run': { type: 'boolean', description: 'Print command without running', default: false },
    },
    async run({ args }) {
        await runStart({
            dir: args.dir,
            memory: args.memory,
            restart: args.restart,
            dryRun: args['dry-run'],
        });
    },
});
