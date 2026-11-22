import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { networkInterfaces } from 'node:os';
import { type RunContext } from '../cli/define.js';
import { introHead, keyValue, nextSteps, note, outroTail } from '../ui/kit.js';
import { c, S } from '../ui/theme.js';
import { resolveServerDir } from '../services/server.js';
import { isAlive, loadPid } from '../services/process.js';
import { serverPort } from '../services/config-file.js';
import { ago, listBackups } from '../services/backup.js';
import { JAR_NAME } from '../infra/paths.js';
import { json } from '../infra/json.js';
import { jarVersion } from '../infra/jar.js';

/**
 * One glance: is it up, since when, and where do players connect.
 *
 * `info` says what is installed; `status` says what is happening. The join
 * addresses are the line people come for - a Bedrock client needs an IP and a
 * port, and most people do not know their machine's LAN address by heart.
 */

/** Non-internal IPv4 addresses of this machine, LAN first. */
export function lanAddresses(): string[] {
    const found: string[] = [];
    for (const list of Object.values(networkInterfaces())) {
        for (const entry of list ?? []) {
            if (entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.')) found.push(entry.address);
        }
    }
    const lan = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
    return found.sort((a, b) => Number(lan(b)) - Number(lan(a)));
}

/** `2 h 14 min`, `3 days 1 h`. */
export function uptime(since: Date, now = Date.now()): string {
    let seconds = Math.max(0, Math.floor((now - since.getTime()) / 1000));
    const days = Math.floor(seconds / 86400); seconds -= days * 86400;
    const hours = Math.floor(seconds / 3600); seconds -= hours * 3600;
    const minutes = Math.floor(seconds / 60);
    if (days > 0) return `${days} day${days > 1 ? 's' : ''} ${hours} h`;
    if (hours > 0) return `${hours} h ${minutes} min`;
    if (minutes > 0) return `${minutes} min`;
    return `${seconds} s`;
}

const countJars = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((file) => file.toLowerCase().endsWith('.jar')).length : 0);
const countDirs = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((name) => {
    try { return statSync(join(dir, name)).isDirectory(); } catch { return false; }
}).length : 0);

export async function runStatus(): Promise<void> {
    const serverDir = await resolveServerDir();
    const record = await loadPid();
    const alive = record !== null && isAlive(record.pid);
    const here = alive && serverDir !== null && resolve(record!.serverPath) === resolve(serverDir);
    const port = serverPort(serverDir);
    const addresses = lanAddresses();
    const backups = serverDir ? await listBackups(serverDir, false) : [];
    const startedAt = alive ? new Date(record!.startedAt) : null;
    const version = serverDir ? jarVersion(join(serverDir, JAR_NAME)) : null;

    if (json.isJson()) {
        json.emit({
            server: serverDir,
            installed: Boolean(serverDir && existsSync(join(serverDir, JAR_NAME))),
            version,
            running: here,
            runningElsewhere: alive && !here ? record!.serverPath : null,
            pid: alive ? record!.pid : null,
            startedAt: startedAt?.toISOString() ?? null,
            uptimeSeconds: startedAt ? Math.floor((Date.now() - startedAt.getTime()) / 1000) : null,
            controllable: alive && Boolean(record!.control),
            port,
            addresses: addresses.map((ip) => `${ip}:${port}`),
            plugins: serverDir ? countJars(join(serverDir, 'plugins')) : 0,
            worlds: serverDir ? countDirs(join(serverDir, 'worlds')) : 0,
            backups: { count: backups.length, latest: backups[0]?.date.toISOString() ?? null },
        });
        return;
    }

    introHead('pnx status', serverDir ?? 'no server here');

    if (!serverDir) {
        nextSteps([['pnx init', 'create a server'], ['pnx use <path>', 'point at an existing one']], 'Try');
        outroTail('No server found.', 'fail');
        return;
    }

    const state = here
        ? `${c.success(S.dot)} ${c.success('running')}  ${c.muted(`PID ${record!.pid} ${S.bullet} up ${uptime(startedAt!)}`)}`
        : alive
            ? `${c.warn(S.dot)} ${c.warn('stopped')}  ${c.muted(`(another server runs: ${record!.serverPath})`)}`
            : `${c.muted(S.ring)} ${c.muted('stopped')}`;

    keyValue({
        State: state,
        Version: version ? `PowerNukkitX ${version}` : c.muted('unknown'),
        Port: `${port} ${c.muted('UDP')}`,
        Plugins: String(countJars(join(serverDir, 'plugins'))),
        Worlds: String(countDirs(join(serverDir, 'worlds'))),
        Backup: backups[0] ? `${ago(backups[0].date)} ${c.muted(`(${backups.length} kept)`)}` : c.warn('never'),
    }, 'Server');

    const rows: Array<[string, string]> = [[`127.0.0.1:${port}`, 'this machine'], ...addresses.map((ip): [string, string] => [`${ip}:${port}`, 'same network'])];
    const width = Math.max(...rows.map(([address]) => address.length));
    const join_ = rows.map(([address, where]) => `${c.brand(address.padEnd(width))}  ${c.muted(where)}`);
    note(join_.join('\n'), 'Players connect to');

    if (here) {
        nextSteps([
            ['pnx cmd say Hello', 'talk to the players'],
            ['pnx logs', 'follow the log'],
            ['pnx stop', 'save and stop'],
        ]);
        outroTail();
        return;
    }
    nextSteps([['pnx start', 'boot it'], ...(backups.length === 0 ? [['pnx backup', 'take a first backup'] as [string, string]] : [])]);
    outroTail();
}

export function statusCommand(ctx: RunContext): Promise<void> {
    void ctx;
    return runStatus();
}
