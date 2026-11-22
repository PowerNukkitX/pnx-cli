import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

/**
 * Reads one file out of a jar without Java and without a zip library.
 *
 * A jar is a zip: the central directory at the end lists every entry with the
 * offset of its local header. Only `META-INF/MANIFEST.MF` is ever wanted here,
 * to learn the PowerNukkitX version in a millisecond instead of booting a JVM.
 */

function readAt(fd: number, position: number, length: number): Buffer {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, position);
    return buffer;
}

export function readJarEntry(jarPath: string, name: string): Buffer | null {
    let fd: number | null = null;
    try {
        fd = openSync(jarPath, 'r');
        const size = statSync(jarPath).size;
        const tailLength = Math.min(size, 65_557); // EOCD (22) + longest comment
        const tail = readAt(fd, size - tailLength, tailLength);
        const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
        if (eocd < 0) return null;
        const entries = tail.readUInt16LE(eocd + 10);
        const dirSize = tail.readUInt32LE(eocd + 12);
        const dirOffset = tail.readUInt32LE(eocd + 16);
        const dir = readAt(fd, dirOffset, dirSize);

        let at = 0;
        for (let index = 0; index < entries && at + 46 <= dir.length; index++) {
            if (dir.readUInt32LE(at) !== 0x02014b50) return null;
            const method = dir.readUInt16LE(at + 10);
            const compressed = dir.readUInt32LE(at + 20);
            const nameLength = dir.readUInt16LE(at + 28);
            const extraLength = dir.readUInt16LE(at + 30);
            const commentLength = dir.readUInt16LE(at + 32);
            const localOffset = dir.readUInt32LE(at + 42);
            const entryName = dir.toString('utf8', at + 46, at + 46 + nameLength);
            if (entryName === name) {
                const local = readAt(fd, localOffset, 30);
                const dataStart = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
                const data = readAt(fd, dataStart, compressed);
                if (method === 0) return data;
                if (method === 8) return inflateRawSync(data);
                return null;
            }
            at += 46 + nameLength + extraLength + commentLength;
        }
        return null;
    } catch {
        return null;
    } finally {
        if (fd !== null) closeSync(fd);
    }
}

/** `Implementation-Version` from the jar's manifest, e.g. `3.0.6-SNAPSHOT`. */
export function jarVersion(jarPath: string): string | null {
    const manifest = readJarEntry(jarPath, 'META-INF/MANIFEST.MF')?.toString('utf8');
    return manifest?.match(/^Implementation-Version:\s*(.+?)\s*$/m)?.[1] ?? null;
}
