import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cwd } from 'node:process';
import { defineCommand } from 'citty';
import { intro, outro, log } from '../ui/output.js';
import { promptSelect, promptText } from '../ui/prompts.js';
import { detectServers, setDefaultServer } from '../services/server.js';
import { JAR_NAME } from '../infra/paths.js';
export const useCmd = defineCommand({
    meta: { description: 'Set the default PowerNukkitX server directory' },
    args: {
        dir: { type: 'positional', description: 'Server path', required: false },
        clear: { type: 'boolean', description: 'Remove default server', default: false },
    },
    async run({ args }) {
        intro(`📌 ${"Default server"}`);
        if (args.clear) {
            await setDefaultServer(null);
            log.success("Default server cleared");
            outro("Default server cleared");
            return;
        }
        let target = args.dir;
        if (!target) {
            const servers = detectServers();
            target = servers.length > 0
                ? await promptSelect("Select a server:", servers.map(s => ({ value: s, label: s })))
                : await promptText({ message: "Server path:", defaultValue: cwd() });
        }
        const absPath = resolve(cwd(), target);
        if (!existsSync(join(absPath, JAR_NAME))) {
            log.error(`powernukkitx.jar not found in: ${absPath}`);
            process.exit(1);
        }
        await setDefaultServer(absPath);
        log.success(`Default server set: ${absPath}`);
        outro(`Default server set: ${absPath}`);
    },
});
