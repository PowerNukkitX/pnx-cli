import { join } from 'node:path';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fetchJSON, downloadFile } from '../infra/http.js';
import { readJson, writeJson } from '../infra/store.js';
import { apiBase } from '../infra/paths.js';
import type { DownloadProgress } from '../infra/http.js';

export type { DownloadProgress } from '../infra/http.js';

/**
 * The plugin marketplace, from listing to uninstall.
 *
 * One source: the hub at powernukkitx.org (GET /api/v1/plugins). Its listing
 * answers search, its detail endpoint carries the approved releases with a
 * sha256 per jar, and the jars themselves live on GitHub releases - the hub
 * only reviews them. Install and update write one registry file, so
 * `pnx plugin installed` tells the truth for either path.
 */

const REGISTRY = 'installed-plugins.json';

export interface PluginEntry {
    slug: string;
    name: string;
    version: string;
    installedAt: string;
    fileName: string;
}

/** What search answers. */
export interface PluginSummary {
    plugins: Array<{
        slug: string;
        name: string;
        author: string;
        description?: string;
        stars: number;
        downloads: number;
        version: string;
    }>;
    count: number;
}

/** What the detail endpoint answers. */
export interface PluginDetail {
    slug: string;
    name: string;
    author: string;
    description?: string;
    latest_version: string;
    downloads: number;
    stars?: number;
    updated_at: string;
    tags: string[];
    repository_url?: string;
    releases: Array<{
        version: string;
        is_stable: boolean;
        created_at: string;
        download_url?: string;
        files?: Array<{ name: string; sha256?: string }>;
    }>;
}

/** What a query means. */
export interface SearchParams {
    sort?: 'newest' | 'updated' | 'stars';
    limit?: number;
    page?: number;
    q?: string;
}

/** A hub plugin as GET /api/v1/plugins returns it. */
interface HubPlugin {
    slug: string;
    name: string;
    summary?: string;
    repo: string;
    status: string;
    categories?: string[];
    submittedBy?: string;
    updatedAt?: string;
    releaseReviews?: Array<{
        tag: string;
        assetName: string;
        publishedAt?: string;
        state: string;
        sha256?: string;
        rejectionReason?: string;
    }>;
    stats?: { downloads?: number; stars?: number; pushedAt?: string };
}

/** A release the hub has reviewed and approved, newest first. */
interface ApprovedRelease {
    tag: string;
    assetName: string;
    publishedAt?: string;
    sha256?: string;
}

export async function searchPlugins(params: SearchParams): Promise<PluginSummary> {
    const qs = new URLSearchParams();
    const perPage = params.limit ?? 24;
    if (perPage) qs.set('perPage', String(perPage));
    if (params.page) qs.set('page', String(params.page));
    if (params.q) qs.set('q', params.q);
    const page = await fetchJSON<{ data: HubPlugin[]; total?: number }>(
        `${apiBase()}/api/v1/plugins?${qs}`,
    );
    const items = page.data.filter((item) => item.status === 'published');
    // the hub decides no order; a bare listing deserves popularity order
    if (!params.q && (!params.sort || params.sort === 'stars')) {
        items.sort((a, b) => (b.stats?.stars ?? 0) - (a.stats?.stars ?? 0));
    }
    return {
        count: page.total ?? items.length,
        plugins: items.map((item) => {
            const latest = approvedReleases(item)[0];
            return {
                slug: item.slug,
                name: item.name,
                author: item.submittedBy ?? '',
                description: item.summary,
                stars: item.stats?.stars ?? 0,
                downloads: item.stats?.downloads ?? 0,
                version: latest?.tag?.replace(/^v/i, '') ?? '',
            };
        }),
    };
}

/** The releases the hub signed off on, newest first, jars only. */
function approvedReleases(item: HubPlugin): ApprovedRelease[] {
    return (item.releaseReviews ?? []).filter(
        (release) => release.state === 'approved' && release.assetName?.endsWith('.jar'),
    );
}

function githubAssetUrl(repo: string, tag: string, assetName: string): string {
    return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
}

export async function getPluginDetail(slug: string): Promise<PluginDetail> {
    const page = await fetchJSON<{ data: HubPlugin }>(
        `${apiBase()}/api/v1/plugins/${encodeURIComponent(slug)}`,
    );
    const item = page.data;
    const releases = approvedReleases(item).map((release) => ({
        version: release.tag,
        is_stable: true,
        created_at: release.publishedAt ?? item.updatedAt ?? '',
        download_url: githubAssetUrl(item.repo, release.tag, release.assetName),
        files: [{ name: release.assetName, sha256: release.sha256 }],
    }));
    return {
        slug: item.slug,
        name: item.name,
        author: item.submittedBy ?? '',
        description: item.summary,
        latest_version: releases[0]?.version?.replace(/^v/i, '') ?? '',
        downloads: item.stats?.downloads ?? 0,
        stars: item.stats?.stars,
        updated_at: item.updatedAt ?? '',
        tags: item.categories ?? [],
        repository_url: item.repo ? `https://github.com/${item.repo}` : undefined,
        releases,
    };
}

export async function fetchApprovedPlugin(slug: string): Promise<{
    name: string;
    status: string;
    releases: Array<{ tag: string; assets: Array<{ name: string; downloadUrl: string }> }>;
} | null> {
    try {
        const response = await fetchJSON<{ data?: HubPlugin }>(
            `${apiBase()}/api/v1/plugins/${encodeURIComponent(slug)}`,
        );
        const item = response.data;
        if (!item) return null;
        return {
            name: item.name,
            status: item.status,
            releases: approvedReleases(item).map((release) => ({
                tag: release.tag,
                assets: [{ name: release.assetName, downloadUrl: githubAssetUrl(item.repo, release.tag, release.assetName) }],
            })),
        };
    } catch (cause) {
        if (cause instanceof Error && /\b404\b/.test(cause.message)) return null;
        throw cause;
    }
}

function pickRelease(detail: PluginDetail): PluginDetail['releases'][number] | null {
    return detail.releases.find((r) => r.is_stable) ?? detail.releases[0] ?? null;
}

/** The hub signs each approved jar with a sha256; a wrong hash means corruption. */
async function verifyJar(sha256: string | undefined, file: string): Promise<void> {
    if (!sha256) return;
    const actual = createHash('sha256').update(await readFile(file)).digest('hex');
    if (actual.toLowerCase() !== sha256.toLowerCase()) {
        await rm(file, { force: true });
        throw new Error(`hash-mismatch:${file.split(/[\\/]/).pop()}`);
    }
}

export async function getInstalled(): Promise<PluginEntry[]> {
    return readJson<PluginEntry[]>(REGISTRY, []);
}

async function recordInstalled(plugin: PluginEntry): Promise<void> {
    const list = await getInstalled();
    const index = list.findIndex((entry) => entry.slug === plugin.slug);
    if (index >= 0) list[index] = plugin;
    else list.push(plugin);
    await writeJson(REGISTRY, list);
}

export async function removeInstalled(slug: string): Promise<void> {
    const list = (await getInstalled()).filter((entry) => entry.slug !== slug);
    await writeJson(REGISTRY, list);
}

/** Installs a plugin from the hub, by slug, straight from GitHub releases. */
export async function installPlugin(
    slug: string,
    pluginsDir: string,
    onProgress?: (progress: DownloadProgress, file: string) => void,
): Promise<PluginEntry> {
    const detail = await getPluginDetail(slug);
    const release = pickRelease(detail);
    if (!release?.download_url) throw new Error(`no-release:${slug}`);
    const file = release.files?.[0];
    if (!file?.name) throw new Error(`no-file:${slug}`);
    await mkdir(pluginsDir, { recursive: true });
    const target = join(pluginsDir, file.name);
    await downloadFile(release.download_url, target, {
        onProgress: (p) => onProgress?.(p, file.name),
    });
    await verifyJar(file.sha256, target);
    const entry: PluginEntry = {
        slug,
        name: detail.name,
        version: release.version.replace(/^v/i, ''),
        installedAt: new Date().toISOString(),
        fileName: file.name,
    };
    await recordInstalled(entry);
    return entry;
}

/** Installs a jar the hub has approved, by slug. */
export async function installApprovedPlugin(
    slug: string,
    pluginsDir: string,
    onProgress?: (progress: DownloadProgress, file: string) => void,
): Promise<PluginEntry> {
    const approved = await fetchApprovedPlugin(slug);
    if (!approved || approved.status !== 'published') throw new Error(`not-approved:${slug}`);
    const first = approved.releases?.[0];
    const jar = first?.assets?.find((a) => a.name.endsWith('.jar'));
    const detail = await getPluginDetail(slug);
    const verified = pickRelease(detail);
    const asset = jar && verified
        ? { url: verified.download_url!, name: jar.name, version: first?.tag ?? verified.version, sha256: verified.files?.[0]?.sha256 }
        : null;
    if (!asset) throw new Error(`no-file:${slug}`);
    await mkdir(pluginsDir, { recursive: true });
    const target = join(pluginsDir, asset.name);
    await downloadFile(asset.url, target, {
        onProgress: (p) => onProgress?.(p, asset.name),
    });
    await verifyJar(asset.sha256, target);
    const entry: PluginEntry = {
        slug,
        name: approved.name,
        version: asset.version.replace(/^v/i, ''),
        installedAt: new Date().toISOString(),
        fileName: asset.name,
    };
    await recordInstalled(entry);
    return entry;
}

/** Installs any .jar URL, tracked or not. */
export async function installFromUrl(
    url: string,
    pluginsDir: string,
    onProgress?: (progress: DownloadProgress, file: string) => void,
): Promise<string> {
    if (!url.endsWith('.jar')) throw new Error('url-invalid');
    await mkdir(pluginsDir, { recursive: true });
    const fileName = url.split('/').pop() ?? 'plugin.jar';
    await downloadFile(url, join(pluginsDir, fileName), { onProgress: (p) => onProgress?.(p, fileName) });
    return fileName;
}

/** Updates one plugin to its newest release; null when it already is. */
export async function updatePlugin(
    slug: string,
    pluginsDir: string,
    currentVersion: string | undefined,
    existingJar: string | undefined,
    onProgress?: (progress: DownloadProgress, file: string) => void,
): Promise<PluginEntry | null> {
    const detail = await getPluginDetail(slug);
    const release = pickRelease(detail);
    if (!release?.download_url) throw new Error(`no-release:${slug}`);
    if (currentVersion && currentVersion === release.version) return null;
    const file = release.files?.[0];
    if (!file?.name) throw new Error(`no-file:${slug}`);

    if (existingJar) {
        await rename(join(pluginsDir, existingJar), join(pluginsDir, `${existingJar}.old`)).catch(() => {});
    }
    const target = join(pluginsDir, file.name);
    await downloadFile(release.download_url, target, {
        onProgress: (p) => onProgress?.(p, file.name),
    });
    if (existingJar) await rm(join(pluginsDir, `${existingJar}.old`)).catch(() => {});
    await verifyJar(file.sha256, target);

    const entry: PluginEntry = {
        slug,
        name: detail.name,
        version: release.version.replace(/^v/i, ''),
        installedAt: new Date().toISOString(),
        fileName: file.name,
    };
    await recordInstalled(entry);
    return entry;
}
