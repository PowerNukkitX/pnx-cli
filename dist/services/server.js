import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { cwd } from 'node:process';
import { platform } from 'node:os';
import { spawn } from 'node:child_process';
import { readJson, writeJson } from '../infra/store.js';
import { JAR_NAME, SCRIPTS_BASE } from '../infra/paths.js';
const CONFIG_FILE = 'config.json';
export async function getDefaultServer() {
    return (await readJson(CONFIG_FILE, {})).defaultServer ?? null;
}
export async function setDefaultServer(path) {
    const cfg = await readJson(CONFIG_FILE, {});
    if (path === null)
        delete cfg.defaultServer;
    else
        cfg.defaultServer = path;
    await writeJson(CONFIG_FILE, cfg);
}
export function detectServers(startPath) {
    const base = startPath || cwd();
    const found = [];
    for (const dir of [base, join(base, 'pnx-server'), dirname(resolve(base))]) {
        if (existsSync(join(dir, JAR_NAME)) && !found.includes(dir))
            found.push(dir);
    }
    return found;
}
export async function resolveServerDir(pick) {
    const def = await getDefaultServer();
    if (def && existsSync(join(def, JAR_NAME)))
        return def;
    const all = detectServers();
    if (all.length === 0)
        return null;
    if (all.length === 1)
        return all[0];
    return pick ? pick(all) : all[0];
}
export function findJava() {
    return process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'java') : 'java';
}
export function checkJava() {
    return new Promise(res => {
        const child = spawn(findJava(), ['-version']);
        let out = '';
        child.on('error', () => res({ ok: false, version: 0, raw: '?', vendor: 'Unknown' }));
        child.stderr.on('data', (d) => (out += d.toString()));
        child.on('close', () => {
            const m = out.match(/(?:openjdk|java) version "?(?:1\.)?(\d+)/i);
            const version = m ? parseInt(m[1]) : 0;
            const vendors = ['Temurin', 'GraalVM', 'Zulu', 'Corretto', 'Oracle', 'Microsoft', 'OpenJDK'];
            const vendor = vendors.find(v => out.toLowerCase().includes(v.toLowerCase())) ?? 'Unknown';
            res({ ok: version >= 21, version, raw: out.split('\n')[0]?.trim() || '?', vendor });
        });
    });
}
export function defaultJavaArgs() {
    return [
        '-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8',
        '-Djansi.passthrough=true', '-Dterminal.ansi=true',
        '-XX:+UseZGC', '-XX:+ZGenerational', '-XX:+UseStringDeduplication',
        '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
        '--add-opens', 'java.base/java.io=ALL-UNNAMED',
        '--add-opens', 'java.base/java.net=ALL-UNNAMED',
    ];
}
export function buildLaunchArgs(memory) {
    return [`-Xms${memory}`, '-XX:MaxRAMPercentage=75.0', ...defaultJavaArgs(), '-jar', JAR_NAME];
}
export function javaEnv() {
    return { ...process.env, JAVA_TOOL_OPTIONS: '-Dfile.encoding=UTF-8', LANG: process.env.LANG ?? 'en_US.UTF-8' };
}
export function startScripts() {
    if (platform() === 'win32')
        return [
            { url: `${SCRIPTS_BASE}/start.bat`, name: 'start.bat' },
            { url: `${SCRIPTS_BASE}/start.ps1`, name: 'start.ps1' },
        ];
    return [{ url: `${SCRIPTS_BASE}/start.sh`, name: 'start.sh' }];
}
