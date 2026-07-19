import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineCommand } from 'citty';
import { intro, outro, log } from '../ui/output.js';
import { c } from '../ui/theme.js';
import { resolveServerDir } from '../services/server.js';
function colorVal(val) {
    if (val === 'true' || val === 'on')
        return c.green(val);
    if (val === 'false' || val === 'off')
        return c.red(val);
    if (/^\d+(\.\d+)?$/.test(val))
        return c.cyan(val);
    return val;
}
export const configCmd = defineCommand({
    meta: { description: 'View server configuration' },
    args: {},
    async run() {
        intro(`⚙️ ${"Configuration"}`);
        const serverPath = await resolveServerDir();
        if (!serverPath) {
            log.error("No server detected");
            process.exit(1);
        }
        let cfgPath = join(serverPath, 'pnx.yml');
        if (!existsSync(cfgPath))
            cfgPath = join(serverPath, 'server.properties');
        if (!existsSync(cfgPath)) {
            log.error("No config file found");
            process.exit(1);
        }
        let content = readFileSync(cfgPath, 'utf-8');
        if (content.charCodeAt(0) === 0xfeff)
            content = content.slice(1);
        const sep = cfgPath.endsWith('.yml') ? ':' : '=';
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) {
                log.raw('');
                continue;
            }
            if (trimmed.startsWith('#')) {
                log.raw(`  ${c.dim(line)}`);
                continue;
            }
            const idx = trimmed.indexOf(sep);
            if (idx > 0) {
                const key = trimmed.slice(0, idx);
                const val = trimmed.slice(idx + 1).trim();
                const indent = line.match(/^(\s*)/)?.[1] ?? '';
                log.raw(`  ${indent}${c.blue(key)}${sep}${val ? ' ' + colorVal(val) : ''}`);
            }
            else
                log.raw(`  ${c.dim(trimmed)}`);
        }
        log.info(`Edit ${cfgPath} to change these values`);
        outro('');
    },
});
