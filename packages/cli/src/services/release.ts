import { fetchJSON, downloadFile } from '../infra/http.js';
import { readJson, writeJson } from '../infra/store.js';
import { GITHUB_LATEST_RELEASE, GITHUB_RELEASES, JAR_NAME } from '../infra/paths.js';

/** Where a release sits on GitHub, reduced to what this CLI acts on. */
export interface Release {
    tag: string;
    version: string;
    assets: Array<{ name: string; url: string; size: number }>;
    publishedAt: string | null;
    prerelease: boolean;
}

/** Github's release payloads, trimmed. */
interface GhRelease {
    tag_name: string;
    /** Drafts are not installable - only published releases carry the jar. */
    draft?: boolean;
    assets: Array<{ name: string; browser_download_url: string; size: number }>;
    published_at: string | null;
    prerelease?: boolean;
}

const CACHE_FILE = 'latest-release.json';
const LIST_CACHE_FILE = 'releases.json';
const CACHE_TTL = 3_600_000;

interface CacheShape {
    fetchedAt: number;
    data: Release | Release[];
}

function normalize(gh: GhRelease): Release {
    return {
        tag: gh.tag_name,
        version: gh.tag_name.replace(/^v/, ''),
        assets: gh.assets.map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size })),
        publishedAt: gh.published_at,
        prerelease: gh.prerelease ?? false,
    };
}

async function cached<T>(file: string, force: boolean): Promise<T | null> {
    if (force) return null;
    const entry = await readJson<CacheShape | null>(file, null);
    if (entry && Date.now() - entry.fetchedAt < CACHE_TTL) return entry.data as T;
    return null;
}

/** The newest release, for one hour of cache. */
export async function getLatestRelease(force = false): Promise<Release> {
    const hit = await cached<Release>(CACHE_FILE, force);
    if (hit) return hit;
    const gh = await fetchJSON<GhRelease>(GITHUB_LATEST_RELEASE);
    const release = normalize(gh);
    await writeJson(CACHE_FILE, { fetchedAt: Date.now(), data: release });
    return release;
}

/** The last thirty releases that actually ship powernukkitx.jar. */
export async function listReleases(force = false): Promise<Release[]> {
    const hit = await cached<Release[]>(LIST_CACHE_FILE, force);
    if (hit) return hit;
    const gh = await fetchJSON<GhRelease[]>(`${GITHUB_RELEASES}?per_page=30`);
    const releases = gh
        .filter((r) => !r.draft)
        .map(normalize)
        .filter((r) => r.assets.some((a) => a.name === JAR_NAME));
    await writeJson(LIST_CACHE_FILE, { fetchedAt: Date.now(), data: releases });
    return releases;
}

/** One release's powernukkitx.jar, if it has one. */
export function findAsset(release: Release): Release['assets'][number] | null {
    return release.assets.find((a) => a.name === JAR_NAME) ?? null;
}

/** Downloads a release's jar into `dest`, calling back as it goes. */
export async function downloadCore(
    release: Release,
    dest: string,
    onProgress?: (progress: { received: number; total: number | null; percent: number | null }) => void,
): Promise<{ size: number }> {
    const asset = findAsset(release);
    if (!asset) throw new Error(`${JAR_NAME} is missing from release ${release.tag}`);
    await downloadFile(asset.url, dest, { onProgress });
    return { size: asset.size };
}
