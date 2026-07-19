import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { storePath } from './paths.js';
export async function readJson(name, fallback) {
    try {
        const file = storePath(name);
        if (existsSync(file))
            return JSON.parse(await readFile(file, 'utf-8'));
    }
    catch { }
    return fallback;
}
export async function writeJson(name, data) {
    const file = storePath(name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(data, null, 2), 'utf-8');
}
export async function removeFile(name) {
    try {
        await rm(storePath(name));
    }
    catch { }
}
