import { existsSync, readdirSync, statSync, readFileSync, watch } from 'node:fs';
import { join } from 'node:path';
import { defineCommand } from 'citty';
import { intro, log } from '../ui/output.js';
import { c } from '../ui/theme.js';
import { resolveServerDir } from '../services/server.js';
export const logsCmd = defineCommand({
    meta: { description: 'View server logs' },
    args: {
        lines: { type: 'string', description: 'Number of lines to show', default: '50' },
        follow: { type: 'boolean', description: 'Follow log output', default: true },
    },
    async run({ args }) {
        intro(`📋 ${"Server logs"}`);
        const serverPath = await resolveServerDir();
        if (!serverPath) {
            log.error("No server detected");
            process.exit(1);
        }
        const logsDir = join(serverPath, 'logs');
        if (!existsSync(logsDir)) {
            log.error("No log files found");
            process.exit(1);
        }
        const files = readdirSync(logsDir)
            .filter(f => f.endsWith('.log') || f === 'latest.log')
            .map(f => ({ name: f, mtime: statSync(join(logsDir, f)).mtime.getTime() }))
            .sort((a, b) => b.mtime - a.mtime);
        if (files.length === 0) {
            log.error("No log files found");
            process.exit(1);
        }
        const logPath = join(logsDir, files[0].name);
        log.step(`Reading ${files[0].name}`);
        const n = parseInt(args.lines) || 50;
        const content = readFileSync(logPath, 'utf-8');
        const colorize = (line) => line.replace(/\[ERROR\]/g, c.red('[ERROR]'))
            .replace(/\[WARN\]/g, c.yellow('[WARN]'))
            .replace(/\[INFO\]/g, c.blue('[INFO]'));
        for (const line of content.split('\n').filter(Boolean).slice(-n)) {
            process.stdout.write(colorize(line) + '\n');
        }
        if (args.follow) {
            log.dim("Live mode (Ctrl+C to quit)");
            process.on('SIGINT', () => { process.stdout.write('\n'); process.exit(0); });
            let buf = content;
            watch(logPath, () => {
                try {
                    const updated = readFileSync(logPath, 'utf-8');
                    if (updated.length > buf.length) {
                        process.stdout.write(updated.slice(buf.length));
                        buf = updated;
                    }
                }
                catch { }
            });
            await new Promise(() => { });
        }
    },
});
