import { join } from 'node:path';
import { mkdir, rename, rm } from 'node:fs/promises';
import { fetchJSON, downloadFile } from '../infra/http.js';
import { readJson, writeJson } from '../infra/store.js';
import { apiBase } from '../infra/paths.js';
const REGISTRY = 'installed-plugins.json';
export async function searchPlugins(params) {
    const qs = new URLSearchParams();
    if (params?.sort)
        qs.set('sort', params.sort);
    if (params?.limit)
        qs.set('limit', String(params.limit));
    if (params?.page)
        qs.set('page', String(params.page));
    if (params?.q)
        qs.set('q', params.q);
    const q = qs.toString();
    return fetchJSON(`${apiBase()}/api/plugins/cli${q ? `?${q}` : ''}`);
}
export async function getPluginDetail(slug) {
    return fetchJSON(`${apiBase()}/api/plugins/cli/${encodeURIComponent(slug)}`);
}
export async function fetchApprovedPlugin(slug) {
    try {
        const res = await fetchJSON(`${apiBase()}/api/v1/plugins/${encodeURIComponent(slug)}`);
        return res?.data ?? null;
    }
    catch (e) {
        if (e?.statusCode === 404)
            return null;
        throw e;
    }
}
function pickJarAsset(detail) {
    for (const rel of detail.releases ?? []) {
        const jar = (rel.assets ?? []).find(a => a.name.endsWith('.jar'));
        if (jar)
            return { url: jar.downloadUrl, name: jar.name, version: rel.tag };
    }
    return null;
}
export async function installApprovedPlugin(slug, pluginsDir, onProgress) {
    const detail = await fetchApprovedPlugin(slug);
    if (!detail || detail.status !== 'published')
        throw new Error(`not-approved:${slug}`);
    const asset = pickJarAsset(detail);
    if (!asset)
        throw new Error(`no-file:${slug}`);
    await mkdir(pluginsDir, { recursive: true });
    const dest = join(pluginsDir, asset.name);
    await downloadFile(asset.url, dest, {
        onProgress: onProgress ? pct => onProgress(pct, asset.name) : undefined,
    });
    const entry = {
        slug, name: detail.name, version: asset.version,
        installedAt: new Date().toISOString(), fileName: asset.name,
    };
    await recordInstalled(entry);
    return entry;
}
export function proxyDownloadUrl(slug, version) {
    const qs = new URLSearchParams({ proxy: '1' });
    if (version)
        qs.set('version', version);
    return `${apiBase()}/api/plugins/${encodeURIComponent(slug)}/download?${qs}`;
}
export function pickRelease(detail) {
    return detail.releases.find(r => r.is_stable) ?? detail.releases[0] ?? null;
}
export async function getInstalled() {
    return readJson(REGISTRY, []);
}
export async function recordInstalled(plugin) {
    const list = await getInstalled();
    const idx = list.findIndex(p => p.slug === plugin.slug);
    if (idx >= 0)
        list[idx] = plugin;
    else
        list.push(plugin);
    await writeJson(REGISTRY, list);
}
export async function removeInstalled(slug) {
    const list = (await getInstalled()).filter(p => p.slug !== slug);
    await writeJson(REGISTRY, list);
}
export async function installPlugin(slug, pluginsDir, onProgress) {
    const detail = await getPluginDetail(slug);
    const release = pickRelease(detail);
    if (!release)
        throw new Error(`no-release:${slug}`);
    const file = release.files[0];
    if (!file)
        throw new Error(`no-file:${slug}`);
    await mkdir(pluginsDir, { recursive: true });
    const dest = join(pluginsDir, file.name);
    await downloadFile(proxyDownloadUrl(slug, release.version), dest, {
        onProgress: onProgress ? pct => onProgress(pct, file.name) : undefined,
    });
    const entry = {
        slug, name: detail.name, version: release.version,
        installedAt: new Date().toISOString(), fileName: file.name,
    };
    await recordInstalled(entry);
    return entry;
}
export async function installFromUrl(url, pluginsDir, onProgress) {
    if (!url.endsWith('.jar'))
        throw new Error('url-invalid');
    await mkdir(pluginsDir, { recursive: true });
    const fileName = url.split('/').pop() ?? 'plugin.jar';
    const dest = join(pluginsDir, fileName);
    await downloadFile(url, dest, { onProgress: onProgress ? pct => onProgress(pct, fileName) : undefined });
    return fileName;
}
export async function updatePlugin(slug, pluginsDir, currentVersion, existingJar, onProgress) {
    const detail = await getPluginDetail(slug);
    const release = pickRelease(detail);
    if (!release)
        throw new Error(`no-release:${slug}`);
    if (currentVersion && currentVersion === release.version)
        return null;
    const file = release.files[0];
    if (!file)
        throw new Error(`no-file:${slug}`);
    if (existingJar) {
        await rename(join(pluginsDir, existingJar), join(pluginsDir, `${existingJar}.old`)).catch(() => { });
    }
    await downloadFile(proxyDownloadUrl(slug, release.version), join(pluginsDir, file.name), {
        onProgress: onProgress ? pct => onProgress(pct, file.name) : undefined,
    });
    if (existingJar)
        await rm(join(pluginsDir, `${existingJar}.old`)).catch(() => { });
    const entry = {
        slug, name: detail.name, version: release.version,
        installedAt: new Date().toISOString(), fileName: file.name,
    };
    await recordInstalled(entry);
    return entry;
}
