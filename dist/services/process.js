import { platform } from 'node:os';
import { spawnSync } from 'node:child_process';
import { readJson, writeJson, removeFile } from '../infra/store.js';
const PID_FILE = 'pid.json';
export async function savePid(pid, serverPath) {
    await writeJson(PID_FILE, { pid, serverPath, startedAt: new Date().toISOString() });
}
export async function loadPid() {
    return readJson(PID_FILE, null);
}
export async function clearPid() {
    await removeFile(PID_FILE);
}
export function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
export async function killProcess(pid) {
    if (!isAlive(pid))
        return false;
    try {
        if (platform() === 'win32') {
            spawnSync('taskkill', ['/PID', String(pid), '/F']);
        }
        else {
            process.kill(pid, 'SIGTERM');
            await new Promise(r => setTimeout(r, 5000));
            if (isAlive(pid))
                process.kill(pid, 'SIGKILL');
        }
        return true;
    }
    catch {
        return false;
    }
}
