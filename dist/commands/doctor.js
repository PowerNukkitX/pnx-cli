import { existsSync, statSync, readdirSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { freemem, totalmem } from 'node:os';
import { defineCommand } from 'citty';
import { intro, outro, log, section, spin, isJson, json } from '../ui/output.js';
import { resolveServerDir, checkJava } from '../services/server.js';
import { JAR_NAME } from '../infra/paths.js';
function checkPort(port) {
    return new Promise(res => {
        const s = createSocket('udp4');
        s.once('error', () => { s.close(); res(false); });
        s.bind(port, '0.0.0.0', () => { s.close(); res(true); });
    });
}
function pnxVersion(jarPath) {
    try {
        const r = spawnSync('java', ['-jar', jarPath, '--version'], { timeout: 3000, encoding: 'utf8' });
        return ((r.stdout || '') + (r.stderr || '')).match(/(\d+\.\d+\.\d+[\w.-]*)/)?.[1] ?? null;
    }
    catch {
        return null;
    }
}
async function diskFreeMb(dir) {
    try {
        const s = await statfs(dir);
        return Math.round((s.bfree * s.bsize) / 1024 / 1024);
    }
    catch {
        return null;
    }
}
export const doctorCmd = defineCommand({
    meta: { description: 'Diagnose server health' },
    args: {},
    async run() {
        const sp = spin("Running diagnostics...");
        const java = await checkJava();
        const serverPath = await resolveServerDir();
        const jarPath = serverPath ? join(serverPath, JAR_NAME) : null;
        const jarExists = jarPath ? existsSync(jarPath) : false;
        const version = jarPath && jarExists ? pnxVersion(jarPath) : null;
        const pluginsDir = serverPath ? join(serverPath, 'plugins') : null;
        const worldsDir = serverPath ? join(serverPath, 'worlds') : null;
        const pluginCount = pluginsDir && existsSync(pluginsDir)
            ? readdirSync(pluginsDir).filter(f => f.endsWith('.jar')).length : 0;
        const worldCount = worldsDir && existsSync(worldsDir)
            ? readdirSync(worldsDir).filter(f => statSync(join(worldsDir, f)).isDirectory()).length : 0;
        const freeMb = Math.round(freemem() / 1024 / 1024);
        const totalMb = Math.round(totalmem() / 1024 / 1024);
        const disk = serverPath ? await diskFreeMb(serverPath) : null;
        const portFree = await checkPort(19132);
        sp.stop("Diagnostics complete");
        if (isJson())
            json({
                java: { ok: java.ok, version: java.raw, vendor: java.vendor },
                server: { found: !!serverPath, path: serverPath, pnxVersion: version },
                ram: { freeMb, totalMb },
                disk: disk !== null ? { freeMb: disk } : null,
                port: { free: portFree, port: 19132 },
                plugins: { count: pluginCount },
                worlds: { count: worldCount },
            });
        intro(`🩺 ${"Server diagnostics"}`);
        section("Java");
        if (java.ok)
            log.success(`${java.raw} (${java.vendor})`);
        else {
            log.error("Java 21+ required");
            log.info('https://adoptium.net/');
        }
        section("Server");
        if (serverPath) {
            log.success(serverPath);
            if (jarExists)
                log.success(`${JAR_NAME}${version ? ` v${version}` : ''}`);
            else
                log.error("powernukkitx.jar missing");
        }
        else
            log.error("No server — run 'pnx init'");
        section("Plugins & Worlds");
        log.info(`Plugins: ${pluginCount}  |  Worlds: ${worldCount}`);
        section("System");
        log.info(`RAM: ${freeMb} MB / ${totalMb} MB`);
        if (disk !== null)
            log.info(`Disk: ${disk} MB`);
        if (portFree)
            log.success(`Port ${'19132'} available`);
        else
            log.warn(`Port ${'19132'} busy`);
        outro("Diagnostics complete");
    },
});
