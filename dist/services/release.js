import { fetchJSON, downloadFile } from '../infra/http.js';
import { readJson, writeJson } from '../infra/store.js';
import { GITHUB_LATEST_RELEASE, GITHUB_RELEASES, JAR_NAME } from '../infra/paths.js';
const CACHE_FILE = 'latest-release.json';
const LIST_CACHE_FILE = 'releases.json';
const CACHE_TTL = 3_600_000;
function normalize(gh) {
    return {
        tag: gh.tag_name,
        version: gh.tag_name.replace(/^v/, ''),
        assets: gh.assets.map(a => ({ name: a.name, url: a.browser_download_url, size: a.size })),
        publishedAt: gh.published_at,
        prerelease: gh.prerelease ?? false,
        body: gh.body,
    };
}
export async function getLatestRelease(force = false) {
    if (!force) {
        const cached = await readJson(CACHE_FILE, null);
        if (cached && Date.now() - cached.fetchedAt < CACHE_TTL)
            return cached.data;
    }
    const gh = await fetchJSON(GITHUB_LATEST_RELEASE);
    const release = normalize(gh);
    await writeJson(CACHE_FILE, { fetchedAt: Date.now(), data: release });
    return release;
}
export async function listReleases(force = false) {
    if (!force) {
        const cached = await readJson(LIST_CACHE_FILE, null);
        if (cached && Date.now() - cached.fetchedAt < CACHE_TTL)
            return cached.data;
    }
    const gh = await fetchJSON(`${GITHUB_RELEASES}?per_page=30`);
    const releases = gh
        .filter(r => !r.draft)
        .map(normalize)
        .filter(r => r.assets.some(a => a.name === JAR_NAME));
    await writeJson(LIST_CACHE_FILE, { fetchedAt: Date.now(), data: releases });
    return releases;
}
export function findAsset(release, name) {
    return release.assets.find(a => a.name === name);
}
export async function downloadCore(release, dest, onProgress) {
    const asset = findAsset(release, JAR_NAME);
    if (!asset)
        throw new Error(`${JAR_NAME} not found in release ${release.tag}`);
    await downloadFile(asset.url, dest, { onProgress: onProgress ? pct => onProgress(pct) : undefined });
    return { size: asset.size };
}
