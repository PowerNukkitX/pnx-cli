import { platform } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { readJson, writeJson, removeFile } from '../infra/store.js';

/**
 * The running server's record, and the ways to ask it to stop.
 *
 * `pnx start` owns the server's stdin and opens a small control socket on
 * 127.0.0.1 (a random port, guarded by a random token). Its address lives in
 * the PID record, so `pnx stop` and `pnx cmd` from any other terminal can type
 * on the server's console - `stop` saves the world before it exits, which a
 * killed process never does.
 */

export interface PidRecord {
    pid: number;
    serverPath: string;
    startedAt: string;
    /** where `pnx start` listens for console lines; absent for older records */
    control?: { port: number; token: string };
}

const PID_FILE = 'pid.json';

export async function savePid(pid: number, serverPath: string, control?: PidRecord['control']): Promise<void> {
    await writeJson(PID_FILE, { pid, serverPath, startedAt: new Date().toISOString(), ...(control ? { control } : {}) });
}

export async function loadPid(): Promise<PidRecord | null> {
    return readJson<PidRecord | null>(PID_FILE, null);
}

export async function clearPid(): Promise<void> {
    await removeFile(PID_FILE);
}

/** True while the process exists; signal 0 asks without touching it. */
export function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (cause) {
        // EPERM: it exists, it is just not ours to signal
        return (cause as NodeJS.ErrnoException)?.code === 'EPERM';
    }
}

/** Types one line on the server console through `pnx start`'s control socket. */
export function sendControl(record: PidRecord, line: string, timeoutMs = 3000): Promise<boolean> {
    const control = record.control;
    if (!control) return Promise.resolve(false);
    return new Promise((resolve) => {
        const socket = createConnection({ host: '127.0.0.1', port: control.port });
        const done = (ok: boolean) => {
            socket.destroy();
            resolve(ok);
        };
        const timer = setTimeout(() => done(false), timeoutMs);
        socket.once('error', () => { clearTimeout(timer); done(false); });
        socket.once('connect', () => socket.write(`${control.token} ${line.replace(/[\r\n]/g, ' ')}\n`));
        socket.once('data', (data) => { clearTimeout(timer); done(data.toString().startsWith('ok')); });
    });
}

/** Waits for a process to be gone; true if it left within the time. */
export async function waitForExit(pid: number, timeoutMs: number, onTick?: (elapsedMs: number) => void): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (!isAlive(pid)) return true;
        onTick?.(Date.now() - started);
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return !isAlive(pid);
}

/**
 * Asks a server to stop the way its owner would: `stop` on its console when
 * `pnx start` left a control socket, a polite signal otherwise. Never kills.
 */
export async function requestStop(record: PidRecord): Promise<'console' | 'signal' | 'none'> {
    if (await sendControl(record, 'stop')) return 'console';
    if (platform() === 'win32') return 'none'; // no polite signal exists for a console app
    try {
        process.kill(record.pid, 'SIGTERM'); // the JVM runs its shutdown hooks
        return 'signal';
    } catch {
        return 'none';
    }
}

/** Ends a process the hard way. The last resort: the world is not saved. */
export async function killProcess(pid: number): Promise<boolean> {
    if (!isAlive(pid)) return false;
    try {
        if (platform() === 'win32') {
            spawnSync('taskkill', ['/PID', String(pid), '/T', '/F']);
        } else {
            process.kill(pid, 'SIGKILL');
        }
        return true;
    } catch {
        return false;
    }
}
