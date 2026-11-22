import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where this CLI keeps its own state on the machine. */
export function pnxHome(): string {
    return process.env.PNX_HOME || join(homedir(), '.pnx-cli');
}

/** Path to a state file, by name, inside the CLI's home. */
export function storePath(name: string): string {
    return join(pnxHome(), name);
}

export const JAR_NAME = 'powernukkitx.jar';

export const GITHUB_LATEST_RELEASE =
    'https://api.github.com/repos/PowerNukkitX/PowerNukkitX/releases/latest';

export const GITHUB_RELEASES = 'https://api.github.com/repos/PowerNukkitX/PowerNukkitX/releases';

export const SCRIPTS_BASE = 'https://raw.githubusercontent.com/PowerNukkitX/scripts/master';

/** The plugin marketplace API, override-able for testing. */
export function apiBase(): string {
    return (process.env.PNX_API_URL ?? 'https://powernukkitx.org').replace(/\/$/, '');
}
