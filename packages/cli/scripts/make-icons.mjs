#!/usr/bin/env node
/**
 * Builds the app icons from the official PowerNukkitX site mark
 * (assets/icon.svg, fetched once from powernukkitx.org/icon.svg).
 *
 * Writes into the desktop app checkout given as argument, by default the
 * sibling ../pnx-app next to this repository (PowerNukkitX/pnx-app).
 *
 * Outputs: icons/icon.ico (16..256, Windows + electron-builder NSIS),
 * icons/icon.png (1024, Linux + mdi for macOS), icons/icon-32.png
 * (window titlebar / taskbar previews).
 */
import { Resvg } from '@resvg/resvg-js';
import pngToIco from 'png-to-ico';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sizes16to256 = [256, 128, 96, 64, 48, 32, 24, 16];

const cliDir = fileURLToPath(new URL('../', import.meta.url));
/** the app lives in its own repository, cloned next to this one */
const appDir = resolve(process.argv[2] ?? join(cliDir, '..', '..', '..', 'pnx-app'));

async function png(size) {
    const svg = await readFile(join(cliDir, 'assets', 'icon.svg'));
    const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
    return resvg.render().asPng();
}

await mkdir(join(appDir, 'icons'), { recursive: true });
await writeFile(join(appDir, 'icons', 'icon-1024.png'), await png(1024));
await writeFile(join(appDir, 'icons', 'icon-32.png'), await png(32));
const ico = await pngToIco(await Promise.all(sizes16to256.map(async (size) => await png(size))));
await writeFile(join(appDir, 'icons', 'icon.ico'), ico);
console.log(`icons written to ${join(appDir, 'icons')}`);
