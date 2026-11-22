import { realpathSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';

/**
 * Which paths the hub is allowed to touch on this machine.
 *
 * The hub refuses a path that climbs out before it queues anything, and that is
 * worth having: a mistake becomes an error message instead of a round trip. But
 * it is a check on a string, made by a process that has never seen this server
 * directory, cannot see a symlink, and talks to us over a token somebody could
 * have taken. This is the check that holds.
 */

export class SandboxError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SandboxError';
    }
}

/**
 * Extensions that must never be written through a remote command.
 *
 * Reading one is fine - an operator inspecting a jar is doing their job.
 * Writing one is arbitrary code arriving over a web session, which is a weaker
 * credential than shell access to the machine it lands on.
 */
const UNWRITABLE = new Set([
    '.jar', '.exe', '.dll', '.so', '.dylib', '.bat', '.cmd', '.com',
    '.ps1', '.sh', '.bash', '.zsh', '.msi', '.scr', '.vbs', '.js', '.mjs', '.cjs',
]);

/** Directories the agent keeps for itself. */
const RESERVED = new Set(['.pnx-agent', '.pnx-trash', '.pnx-part']);

/**
 * A path inside the server directory, or an error naming what was wrong.
 *
 * An empty path is the directory itself, which is the starting point of every
 * file listing and not a mistake.
 */
export function resolveUnder(serverDir: string, relative?: string | null): string {
    const root = realpathSync(serverDir);

    if (relative === undefined || relative === null || relative === '') return root;
    if (typeof relative !== 'string') throw new SandboxError('that path is not a string');
    if (isAbsolute(relative)) {
        throw new SandboxError('absolute paths are refused; give a path inside the server directory');
    }
    // named before collapsing: normalize("..") only reads as "..", and the user
    // deserves the sentence rather than a generic refusal
    if (relative.split(/[/\\]/).some((part) => part === '..')) {
        throw new SandboxError('a path may not climb out of the server directory');
    }
    if (relative.split(/[/\\]/).some((part) => RESERVED.has(part))) {
        throw new SandboxError('that directory belongs to the agent');
    }
    if (relative.includes('\u0000')) throw new SandboxError('that path contains a null byte');

    const target = resolve(root, normalize(relative));

    // startsWith with the separator appended: a sibling whose name merely begins
    // with the same characters must not pass
    if (target !== root && !target.startsWith(root + sep)) {
        throw new SandboxError('a path may not climb out of the server directory');
    }

    // and again after following symlinks, for the part of the path that exists
    let real = target;
    try {
        real = realpathSync(target);
    } catch {
        // does not exist yet, which is legal for a write or a mkdir; the parent
        // is what had to be inside, and it is, because `target` is
        return target;
    }

    if (real !== root && !real.startsWith(root + sep)) {
        throw new SandboxError('that path is a link pointing outside the server directory');
    }

    return real;
}

/** The same rule set, plus "no code arriving over a web session". */
export function assertWritable(path: string): string {
    const dot = path.lastIndexOf('.');
    const extension = dot === -1 ? '' : path.slice(dot).toLowerCase();
    if (UNWRITABLE.has(extension)) {
        throw new SandboxError(
            `writing ${extension} files is refused; install plugins through the marketplace instead`,
        );
    }
    return path;
}

/** Where the agent keeps the things it owns, always inside the server. */
export function agentDir(serverDir: string): string {
    return join(serverDir, '.pnx-agent');
}
