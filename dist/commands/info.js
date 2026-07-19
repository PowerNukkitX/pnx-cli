import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { freemem, totalmem } from 'node:os';
import { defineCommand } from 'citty';
import { intro, outro, log, section, isJson, json } from '../ui/output.js';
import { c } from '../ui/theme.js';
import { resolveServerDir } from '../services/server.js';
export const infoCmd = defineCommand({
    meta: { description: 'Show server information' },
    args: {},
    async run() {
        const serverPath = await resolveServerDir();
        const installed = serverPath !== null;
        let plugins = [], worlds = [];
        if (serverPath && existsSync(join(serverPath, 'plugins'))) {
            plugins = (await readdir(join(serverPath, 'plugins'))).filter(f => f.endsWith('.jar'));
        }
        if (serverPath && existsSync(join(serverPath, 'worlds'))) {
            worlds = await readdir(join(serverPath, 'worlds'));
        }
        const freeMb = Math.round(freemem() / 1024 / 1024);
        const totalMb = Math.round(totalmem() / 1024 / 1024);
        if (isJson())
            json({
                status: installed ? 'installed' : 'not_installed',
                serverDir: serverPath, plugins: plugins.length, worlds: worlds.length,
                ram: { freeMb, totalMb },
            });
        intro(`📊 ${"Server info"}`);
        section("Server");
        log.info(`${"Status".padEnd(12)} ${installed ? c.green('✔ ' + "Installed") : c.red('✘ ' + "Not installed")}`);
        if (serverPath)
            log.info(`${"Path".padEnd(12)} ${c.accent(serverPath)}`);
        log.info(`${"Plugins".padEnd(12)} ${plugins.length}`);
        log.info(`${"Worlds".padEnd(12)} ${worlds.length}`);
        section("System");
        log.info(`${"Free RAM".padEnd(12)} ${freeMb} MB / ${totalMb} MB`);
        outro(installed ? "Ready to start with 'pnx start'" : "Run 'pnx init' to create a server");
    },
});
