import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { cwd } from 'node:process';
import { platform } from 'node:os';
import { spawn } from 'node:child_process';
import { readJson, writeJson } from '../infra/store.js';
import { JAR_NAME, SCRIPTS_BASE } from '../infra/paths.js';

/** What the CLI remembers about which server is "the" server. */
const CONFIG_FILE = 'config.json';

export async function getDefaultServer(): Promise<string | null> {
    const cfg = await readJson<Record<string, string | undefined>>(CONFIG_FILE, {});
    return cfg.defaultServer ?? null;
}

export async function setDefaultServer(path: string | null): Promise<void> {
    const cfg = await readJson<Record<string, string | undefined>>(CONFIG_FILE, {});
    if (path === null) delete cfg.defaultServer;
    else cfg.defaultServer = path;
    await writeJson(CONFIG_FILE, cfg);
}

/** Directories nearby that hold a powernukkitx.jar, nearest first. */
export function detectServers(startPath?: string): string[] {
    const base = startPath || cwd();
    const found: string[] = [];
    for (const dir of [base, join(base, 'pnx-server'), dirname(resolve(base))]) {
        if (existsSync(join(dir, JAR_NAME)) && !found.includes(dir)) found.push(dir);
    }
    return found;
}

/**
 * The directory the current command should work on.
 *
 * Order of authority: an explicit pick (interactive), the stored default, then
 * whatever was found nearby. A resolved default that has since been deleted is
 * worth the same as none - the jar is the fact, the path is a label for it.
 */
export async function resolveServerDir(
    pick?: (found: string[]) => Promise<string>,
): Promise<string | null> {
    const def = await getDefaultServer();
    if (def && existsSafely(join(def, JAR_NAME))) return def;
    const found = detectServers();
    if (found.length === 0) return null;
    if (found.length === 1) return found[0]!;
    return pick ? pick(found) : found[0]!;
}

function existsSafely(path: string): boolean {
    return existsSync(path) || false;
}

/**
 * The oldest Java PowerNukkitX boots on. One constant, so the check, every
 * message that names it, and the docs can never disagree again.
 */
export const MIN_JAVA = 25;

export interface JavaInfo {
    ok: boolean;
    version: number;
    raw: string;
    vendor: string;
}

/** The java this machine actually uses, JAVA_HOME first. */
export function findJava(): string {
    return process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'java') : 'java';
}

/** Runs `java -version` and reads what it means for PowerNukkitX. */
export function checkJava(): Promise<JavaInfo> {
    return new Promise((resolvePromise) => {
        const child = spawn(findJava(), ['-version']);
        let out = '';
        child.on('error', () => resolvePromise({ ok: false, version: 0, raw: '?', vendor: 'Unknown' }));
        child.stderr.on('data', (data) => (out += data.toString()));
        child.on('close', () => {
            const match = out.match(/(?:openjdk|java) version "?(?:1\.)?(\d+)/i);
            const version = match ? Number.parseInt(match[1]!, 10) : 0;
            const vendors = ['Temurin', 'GraalVM', 'Zulu', 'Corretto', 'Oracle', 'Microsoft', 'OpenJDK'];
            const vendor =
                vendors.find((v) => out.toLowerCase().includes(v.toLowerCase())) ?? 'Unknown';
            const firstLine = out.split('\n')[0]?.trim() ?? '?';
            resolvePromise({ ok: version >= MIN_JAVA, version, raw: firstLine, vendor });
        });
    });
}

/**
 * Reads a memory size the way people write it - `2G`, `2g`, `2GB`, `2048M`,
 * `4 GB` - and returns the JVM's spelling (`2G`, `2048M`), or null.
 */
export function parseMemory(text: string | undefined | null): string | null {
    const m = String(text ?? '').trim().match(/^(\d+(?:[.,]\d+)?)\s*([mg])(?:i?b)?$/i);
    if (!m) return null;
    const value = Number(m[1]!.replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) return null;
    const unit = m[2]!.toUpperCase();
    if (unit === 'G' && !Number.isInteger(value)) return `${Math.round(value * 1024)}M`;
    const mb = unit === 'G' ? value * 1024 : value;
    if (mb < 512) return null; // below this PowerNukkitX does not boot
    return `${value}${unit}`;
}

function memoryMb(memory: string): number {
    const m = memory.match(/^(\d+)([MG])$/);
    return m ? Number(m[1]) * (m[2] === 'G' ? 1024 : 1) : 1024;
}

/**
 * The tuning PowerNukkitX likes: UTF-8 everywhere, ZGC, module opens.
 * `-XX:+ZGenerational` only means something on Java 21-22: from 23 it is the
 * default, and from 24 the JVM warns it ignores the flag.
 */
export function defaultJavaArgs(javaVersion?: number): string[] {
    const generational = !javaVersion || javaVersion < 23 ? ['-XX:+ZGenerational'] : [];
    return [
        '-Dfile.encoding=UTF-8',
        '-Dstdout.encoding=UTF-8',
        '-Dstderr.encoding=UTF-8',
        '-Djansi.passthrough=true',
        '-Dterminal.ansi=true',
        '-XX:+UseZGC',
        ...generational,
        '-XX:+UseStringDeduplication',
        '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
        '--add-opens', 'java.base/java.io=ALL-UNNAMED',
        '--add-opens', 'java.base/java.net=ALL-UNNAMED',
    ];
}

/**
 * The heap: `memory` is the ceiling (-Xmx), what a person means by "give it
 * 4 GB"; it starts at a quarter of that (at least 512 MB) so a small machine
 * is not drained at boot.
 */
export function heapArgs(memory: string): string[] {
    return [`-Xms${Math.max(512, Math.floor(memoryMb(memory) / 4))}M`, `-Xmx${memory}`];
}

/** The full java command a server is started with. */
export function buildLaunchArgs(memory: string, javaVersion?: number): string[] {
    return [...heapArgs(memory), ...defaultJavaArgs(javaVersion), '-jar', JAR_NAME];
}

/** Environment tweaks a server console needs to render correctly. */
export function javaEnv(): NodeJS.ProcessEnv {
    return {
        ...process.env,
        JAVA_TOOL_OPTIONS: '-Dfile.encoding=UTF-8',
        LANG: process.env.LANG ?? 'en_US.UTF-8',
    };
}

/** Where the official start scripts live, for this platform. */
export function officialStartScripts(): Array<{ url: string; name: string }> {
    if (platform() === 'win32') {
        return [
            { url: `${SCRIPTS_BASE}/start.bat`, name: 'start.bat' },
            { url: `${SCRIPTS_BASE}/start.ps1`, name: 'start.ps1' },
        ];
    }
    return [{ url: `${SCRIPTS_BASE}/start.sh`, name: 'start.sh' }];
}
