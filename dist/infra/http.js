import https from 'node:https';
import http from 'node:http';
import { createWriteStream } from 'node:fs';
const REDIRECT_CODES = [301, 302, 303, 307, 308];
export class NetworkError extends Error {
    statusCode;
    constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
        this.name = 'NetworkError';
    }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function get(url, timeoutMs, headers) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, { timeout: timeoutMs, headers }, (res) => {
            let body = '';
            res.on('data', (chunk) => (body += chunk.toString()));
            res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, location: res.headers.location, body }));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', function () {
            this.destroy();
            reject(new NetworkError('Request timed out'));
        });
    });
}
async function getFollow(url, timeout, headers, redirects = 5) {
    if (redirects <= 0)
        throw new NetworkError('Too many redirects');
    const res = await get(url, timeout, { 'User-Agent': 'pnx-cli', ...headers });
    if (REDIRECT_CODES.includes(res.statusCode) && res.location) {
        return getFollow(res.location, timeout, headers, redirects - 1);
    }
    if (res.statusCode !== 200)
        throw new NetworkError(`HTTP ${res.statusCode}`, res.statusCode);
    return res.body;
}
export async function fetchJSON(url, opts) {
    const retries = opts?.retries ?? 3;
    const timeout = opts?.timeout ?? 15_000;
    const headers = opts?.headers ?? {};
    let lastErr = new Error('Unknown error');
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return JSON.parse(await getFollow(url, timeout, headers));
        }
        catch (err) {
            lastErr = err;
            if (attempt < retries) {
                opts?.onRetry?.(lastErr.message, attempt, retries);
                await sleep(2 ** (attempt - 1) * 1000);
            }
        }
    }
    throw lastErr;
}
function stream(url, dest, timeout, onData) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const file = createWriteStream(dest);
        const req = mod.get(url, { timeout, headers: { 'User-Agent': 'pnx-cli' } }, (res) => {
            const code = res.statusCode ?? 0;
            if (REDIRECT_CODES.includes(code) && res.headers.location) {
                file.close();
                resolve(stream(res.headers.location, dest, timeout, onData));
                return;
            }
            if (code !== 200) {
                file.close();
                reject(new NetworkError(`HTTP ${code}`, code));
                return;
            }
            const total = parseInt(res.headers['content-length'] || '0', 10);
            res.on('data', (chunk) => onData(chunk, total));
            res.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
            file.on('error', reject);
        });
        req.on('error', err => { file.close(); reject(err); });
        req.on('timeout', function () {
            this.destroy();
            file.close();
            reject(new NetworkError('Download timed out'));
        });
    });
}
export async function downloadFile(url, dest, opts) {
    const retries = opts?.retries ?? 3;
    const timeout = opts?.timeout ?? 120_000;
    let lastErr = new Error('Unknown error');
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            let downloaded = 0;
            let lastPct = -1;
            await stream(url, dest, timeout, (chunk, total) => {
                downloaded += chunk.length;
                if (opts?.onProgress && total > 0) {
                    const pct = Math.round((downloaded / total) * 100);
                    if (pct !== lastPct && pct % 5 === 0) {
                        opts.onProgress(pct, downloaded, total);
                        lastPct = pct;
                    }
                }
            });
            return;
        }
        catch (err) {
            lastErr = err;
            if (attempt < retries) {
                opts?.onRetry?.(lastErr.message, attempt, retries);
                await sleep(2 ** (attempt - 1) * 1000);
            }
        }
    }
    throw lastErr;
}
