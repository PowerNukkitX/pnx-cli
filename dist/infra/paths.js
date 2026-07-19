import { homedir } from 'node:os';
import { join } from 'node:path';
export function pnxHome() {
    return process.env.PNX_HOME || join(homedir(), '.pnx-cli');
}
export function storePath(name) {
    return join(pnxHome(), name);
}
export const JAR_NAME = 'powernukkitx.jar';
export const GITHUB_LATEST_RELEASE = 'https://api.github.com/repos/PowerNukkitX/PowerNukkitX/releases/latest';
export const GITHUB_RELEASES = 'https://api.github.com/repos/PowerNukkitX/PowerNukkitX/releases';
export const SCRIPTS_BASE = 'https://raw.githubusercontent.com/PowerNukkitX/scripts/master';
export function apiBase() {
    return (process.env.PNX_API_URL ?? 'https://api.powernukkitx.org').replace(/\/$/, '');
}
