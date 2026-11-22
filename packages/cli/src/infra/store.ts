import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { storePath } from './paths.js';

/**
 * Reads a JSON state file, or the fallback when it is missing or unreadable.
 *
 * A corrupt state file is deleted rather than reported: the store holds caches
 * and convenience defaults, never data the user authored, so the right thing
 * after a torn write is to start over quietly.
 */
export async function readJson<T>(name: string, fallback: T): Promise<T> {
    const file = storePath(name);
    try {
        if (existsSync(file)) return JSON.parse(await readFile(file, 'utf-8')) as T;
    } catch {
        try {
            await rm(file, { force: true });
        } catch {
            // unreadable and unremovable: answer from the fallback and let the
            // next write overwrite it
        }
    }
    return fallback;
}

/** Writes a JSON state file, creating the store directory on the way. */
export async function writeJson(name: string, data: unknown): Promise<void> {
    const file = storePath(name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(data, null, 2), 'utf-8');
}

/** Removes a state file. Failing to remove a missing file is not a failure. */
export async function removeFile(name: string): Promise<void> {
    await rm(storePath(name), { force: true });
}
