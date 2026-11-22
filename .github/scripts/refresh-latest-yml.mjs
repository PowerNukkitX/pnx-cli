#!/usr/bin/env node
/*
 * After SignPath signs the Windows installer, its bytes change: rewrite the
 * sha512 and size in latest.yml so electron-updater accepts the signed file,
 * and drop the blockmap (it describes the unsigned bytes; without it the
 * updater simply downloads the whole installer).
 *
 *   node .github/scripts/refresh-latest-yml.mjs packages/app/release
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const manifest = join(dir, 'latest.yml');
if (!existsSync(manifest)) {
    console.error(`no latest.yml in ${dir}`);
    process.exit(1);
}

let text = readFileSync(manifest, 'utf8');
const files = [...text.matchAll(/url:\s*(\S+)/g)].map((match) => match[1]);

for (const name of files) {
    const path = join(dir, name);
    if (!existsSync(path)) {
        console.error(`latest.yml names ${name}, which is not in ${dir}`);
        process.exit(1);
    }
    const sha512 = createHash('sha512').update(readFileSync(path)).digest('base64');
    const size = statSync(path).size;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // the files: entry
    text = text.replace(
        new RegExp(`(- url: ${escaped}\\n\\s+sha512: )\\S+(\\n\\s+size: )\\d+`),
        `$1${sha512}$2${size}`,
    );
    // the top-level path/sha512 pair (the installer)
    text = text.replace(new RegExp(`(path: ${escaped}\\nsha512: )\\S+`), `$1${sha512}`);
    rmSync(`${path}.blockmap`, { force: true });
    console.log(`${name}: ${size} bytes, sha512 ${sha512.slice(0, 16)}…`);
}

writeFileSync(manifest, text);
