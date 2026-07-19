#!/usr/bin/env node
import { defineCommand, runMain } from 'citty';
import { setColorEnabled } from './ui/theme.js';
if (process.argv.slice(2).includes('--no-color'))
    setColorEnabled(false);
const main = defineCommand({
    meta: {
        name: 'pnx',
        version: '1.0.0',
        description: 'PowerNukkitX CLI — Manage your Minecraft Bedrock servers',
    },
    subCommands: {
        init: () => import('./commands/init.js').then(m => m.initCmd),
        install: () => import('./commands/install.js').then(m => m.installCmd),
        start: () => import('./commands/start.js').then(m => m.startCmd),
        stop: () => import('./commands/stop.js').then(m => m.stopCmd),
        update: () => import('./commands/update.js').then(m => m.updateCmd),
        info: () => import('./commands/info.js').then(m => m.infoCmd),
        doctor: () => import('./commands/doctor.js').then(m => m.doctorCmd),
        backup: () => import('./commands/backup.js').then(m => m.backupCmd),
        config: () => import('./commands/config.js').then(m => m.configCmd),
        use: () => import('./commands/use.js').then(m => m.useCmd),
        logs: () => import('./commands/logs.js').then(m => m.logsCmd),
        console: () => import('./commands/console.js').then(m => m.consoleCmd),
        plugin: () => import('./commands/plugin/index.js').then(m => m.pluginCmd),
    },
    async run({ args }) {
        if (args._.length === 0) {
            const { runMenu } = await import('./commands/menu.js');
            await runMenu();
        }
    },
});
runMain(main);
