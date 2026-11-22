import { existsSync, readdirSync, statSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { createSocket } from 'node:dgram';
import { freemem, totalmem } from 'node:os';
import { type RunContext } from '../cli/define.js';
import { introHead, keyValue, nextSteps, outroTail, spinner } from '../ui/kit.js';
import { c, S } from '../ui/theme.js';
import { resolveServerDir, checkJava, MIN_JAVA } from '../services/server.js';
import { serverPort } from '../services/config-file.js';
import { json } from '../infra/json.js';
import { JAR_NAME } from '../infra/paths.js';
import { jarVersion } from '../infra/jar.js';

/**
 * Diagnosing whether this server could start.
 *
 * One verdict per line, in one column, and the lines that are not fine are the
 * only coloured things on screen. The point is that a `bad` line is never
 * decorative: each one carries a fix in the footer if the run found anything
 * blocking.
 */

function checkPort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = createSocket('udp4');
        socket.once('error', () => {
            socket.close();
            resolve(false);
        });
        socket.bind(port, '0.0.0.0', () => {
            socket.close();
            resolve(true);
        });
    });
}

/** The PowerNukkitX version, read from the jar's manifest in a millisecond. */
function pnxVersionFrom(jarPath: string): string | null {
    return jarVersion(jarPath);
}

async function diskFreeMb(dir: string): Promise<number | null> {
    try {
        const stats = await statfs(dir);
        return Math.round((stats.bfree * stats.bsize) / 1024 / 1024);
    } catch {
        return null;
    }
}

export async function runDoctor(): Promise<void> {
    if (!json.isJson()) introHead('pnx doctor', 'can this server start today?');

    const sp = spinner();
    sp.start('Checking this machine...');

    const java = await checkJava();
    const serverPath = await resolveServerDir();
    const jarPath = serverPath ? join(serverPath, JAR_NAME) : null;
    const jarExists = jarPath ? existsSync(jarPath) : false;
    const version = jarPath && jarExists ? pnxVersionFrom(jarPath) : null;
    const pluginsDir = serverPath ? join(serverPath, 'plugins') : null;
    const worldsDir = serverPath ? join(serverPath, 'worlds') : null;
    const pluginCount =
        pluginsDir && existsSync(pluginsDir) ? readdirSync(pluginsDir).filter((f) => f.endsWith('.jar')).length : 0;
    const worldCount =
        worldsDir && existsSync(worldsDir)
            ? readdirSync(worldsDir).filter((f) => statSync(join(worldsDir, f)).isDirectory()).length
            : 0;
    const freeMb = Math.round(freemem() / 1024 / 1024);
    const totalMb = Math.round(totalmem() / 1024 / 1024);
    const disk = serverPath ? await diskFreeMb(serverPath) : null;
    const port = serverPort(serverPath);
    const portFree = await checkPort(port);

    sp.stop('Checked');

    if (json.isJson()) {
        json.emit({
            ok: java.ok && Boolean(serverPath) && jarExists,
            java: { ok: java.ok, version: java.raw, vendor: java.vendor },
            server: { found: Boolean(serverPath), path: serverPath, pnxVersion: version },
            ram: { freeMb, totalMb },
            disk: disk !== null ? { freeMb: disk } : null,
            port: { free: portFree, port },
            plugins: { count: pluginCount },
            worlds: { count: worldCount },
        });
        if (!java.ok || !serverPath || !jarExists) process.exitCode = 1;
        return;
    }

    const okFlag = (text: string) => `${c.success(S.dot)} ${text}`;
    const badFlag = (text: string) => `${c.error(S.dot)} ${text}`;
    const warnFlag = (text: string) => `${c.warn(S.dot)} ${text}`;
    const plain = (text: string) => `${c.muted(S.bullet)} ${text}`;

    keyValue(
        {
            Java: java.ok ? okFlag(`${java.raw} (${java.vendor})`) : badFlag(`Java ${MIN_JAVA} or newer is required`),
            Server: serverPath ? okFlag(serverPath) : badFlag('no server directory found'),
            Jar: !serverPath
                ? plain('nothing to check')
                : jarExists
                    ? okFlag(`${JAR_NAME}${version ? `  v${version}` : ''}`)
                    : badFlag(`${JAR_NAME} missing`),
        },
        'Install',
    );
    keyValue(
        {
            Memory: plain(`${freeMb} MB free of ${totalMb} MB`),
            Disk: disk !== null ? plain(`${disk} MB free`) : plain('unknown'),
            [`Port ${port}`]: portFree ? okFlag('available') : warnFlag('already in use'),
        },
        'Machine',
    );
    keyValue(
        {
            Plugins: plain(String(pluginCount)),
            Worlds: plain(String(worldCount)),
        },
        'Contents',
    );

    const blocking: string[] = [];
    if (!java.ok) blocking.push(`Install Java ${MIN_JAVA} from https://adoptium.net/`);
    if (!serverPath) blocking.push('Create a server with `pnxcli` or `pnx init`');
    else if (!jarExists) blocking.push('Restore the jar with `pnx update`');

    if (blocking.length > 0) {
        nextSteps(blocking.map((fix) => [fix, ''] as [string, string?]), 'Fix');
        outroTail('This server will not start until the items above are addressed.', 'fail');
        return;
    }

    outroTail(
        portFree
            ? 'Nothing blocking. Start it with `pnx start`.'
            : `Nothing blocking, but something already holds port ${port} (is the server already running?).`,
    );
}

export function doctorCommand(ctx: RunContext): Promise<void> {
    void ctx;
    return runDoctor();
}
