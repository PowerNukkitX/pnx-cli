import { readJson, writeJson } from './store.js';
import { VERSION } from './version.js';
import { json } from './json.js';
import { c, S } from '../ui/theme.js';

/**
 * "A newer pnx is out" - said once a day at most, after the command's own
 * output, never in its way.
 *
 * The check reads a cached answer synchronously at the end of a run and
 * refreshes that cache in the background for the next one, so no command ever
 * waits on the network for it. It stays silent in scripts, CI, `--json` runs
 * and pipes, and `PNX_NO_UPDATE_CHECK=1` turns it off for good.
 */

const CACHE = 'update-check.json';
const DAY_MS = 24 * 60 * 60 * 1000;
const REGISTRY = 'https://registry.npmjs.org/@powernukkitx%2fcli/latest';

interface Cache {
    checkedAt: number;
    latest: string | null;
}

/** Numeric semver compare: >0 when a is newer. Pre-release tags are ignored. */
export function compareVersions(a: string, b: string): number {
    const parse = (version: string) => version.replace(/^v/, '').split(/[-+]/)[0]!.split('.').map((part) => Number.parseInt(part, 10) || 0);
    const left = parse(a);
    const right = parse(b);
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
        const diff = (left[index] ?? 0) - (right[index] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

function enabled(): boolean {
    return !process.env.PNX_NO_UPDATE_CHECK
        && !process.env.NO_UPDATE_NOTIFIER
        && !process.env.CI
        && !json.isJson()
        && Boolean(process.stdout.isTTY)
        && Boolean(process.stderr.isTTY);
}

async function refresh(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    timer.unref();
    try {
        const response = await fetch(REGISTRY, { signal: controller.signal, headers: { accept: 'application/json' } });
        const body = (await response.json()) as { version?: string };
        await writeJson(CACHE, { checkedAt: Date.now(), latest: body.version ?? null } satisfies Cache);
    } catch {
        // offline, or the registry is slow: try again tomorrow
        await writeJson(CACHE, { checkedAt: Date.now(), latest: null } satisfies Cache).catch(() => undefined);
    } finally {
        clearTimeout(timer);
    }
}

let pending: Promise<void> | null = null;
let notice: string | null = null;

/** Starts the check: reads the cache now, refreshes it in the background if stale. */
export async function startUpdateCheck(): Promise<void> {
    if (!enabled()) return;
    const cache = await readJson<Cache | null>(CACHE, null);
    if (cache?.latest && compareVersions(cache.latest, VERSION) > 0) {
        notice = cache.latest;
    }
    if (!cache || Date.now() - cache.checkedAt > DAY_MS) {
        pending = refresh();
    }
}

/** Prints the notice, if any, on stderr; lets a refresh in flight finish briefly. */
export async function finishUpdateCheck(): Promise<void> {
    if (pending) await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 300).unref())]);
    if (!notice || !enabled()) return;
    const line = `${c.gold('Update available')} ${c.muted(VERSION)} ${c.muted(S.arrow)} ${c.brand(notice)}   ${c.info('npm i -g @powernukkitx/cli')}`;
    process.stderr.write(`\n${line}\n`);
}
