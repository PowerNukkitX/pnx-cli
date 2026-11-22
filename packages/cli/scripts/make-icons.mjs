#!/usr/bin/env node
/**
 * Builds the app icons from the official PowerNukkitX site mark
 * (assets/icon.svg, fetched once from powernukkitx.org/icon.svg).
 *
 * Outputs: app/icons/icon.ico (16..256, Windows + electron-builder NSIS),
 * app/icons/icon.png (1024, Linux + mdi for macOS), app/icons/icon-32.png
 * (window titlebar / taskbar previews).
 */
import { Resvg } from '@resvg/resvg-js';
import pngToIco from 'png-to-ico';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sizes16to256 = [256, 128, 96, 64, 48, 32, 24, 16];

/** the app lives in the sibling workspace: packages/app */
const appDir = join(fileURLToPath(new URL('../../', import.meta.url)), 'app');

async function png(size) {
    const svg = await readFile(join(appDir, '..', 'cli', 'assets', 'icon.svg'));
    const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
    return resvg.render().asPng();
}

await mkdir(join(appDir, 'icons'), { recursive: true });
await writeFile(join(appDir, 'icons', 'icon-1024.png'), await png(1024));
await writeFile(join(appDir, 'icons', 'icon-32.png'), await png(32));
const ico = await pngToIco(await Promise.all(sizes16to256.map(async (size) => await png(size))));
await writeFile(join(appDir, 'icons', 'icon.ico'), ico);
console.log('icons written to packages/app/icons');
