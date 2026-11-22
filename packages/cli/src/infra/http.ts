import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';

/**
 * Traffic with GitHub and the marketplace.
 *
 * Native `fetch` everywhere: it follows redirects by itself, collapses the
 * http/https module juggling the old client had to spell out, and its Abort
 * signal turns "the other end went quiet" into a plain response timeout.
 */

const REDIRECT_LIMIT = 5;

export class NetworkError extends Error {
    readonly statusCode: number;

    constructor(message: string, statusCode = 0) {
        super(message);
        this.name = 'NetworkError';
        this.statusCode = statusCode;
    }
}

export class HttpError extends NetworkError {
    constructor(statusCode: number, body: string) {
        super(body ? body.slice(0, 300) : `HTTP ${statusCode}`, statusCode);
    }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One request with a hard response timeout, following redirects by hand. */
async function request(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    depth = 0,
): Promise<Response> {
    if (depth > REDIRECT_LIMIT) throw new NetworkError('Too many redirects');

    let response: Response;
    try {
        response = await fetch(url, {
            ...init,
            headers: {
                'user-agent': 'pnx-cli',
                // an optional token lifts GitHub's 60-requests-an-hour limit
                ...(process.env.GITHUB_TOKEN && new URL(url).hostname === 'api.github.com'
                    ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
                ...(init.headers as Record<string, string>),
            },
            redirect: 'manual',
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (cause) {
        throw new NetworkError(
            cause instanceof Error && cause.name === 'TimeoutError'
                ? `Request timed out (${Math.round(timeoutMs / 1000)}s)`
                : `Could not reach ${url}`,
        );
    }

    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.get('location')) {
        return request(response.headers.get('location')!, init, timeoutMs, depth + 1);
    }

    return response;
}

/** GETs a URL and parses the answer as JSON, with retries and backoff. */
export async function fetchJSON<T>(
    url: string,
    opts: {
        timeout?: number;
        retries?: number;
        /** 4xx answers are the caller's mistake; retrying just adds delay. */
        retryOnStatus?: boolean;
        onRetry?: (message: string, attempt: number, retries: number) => void;
    } = {},
): Promise<T> {
    const retries = opts.retries ?? 2;
    const timeout = opts.timeout ?? 15_000;
    let lastError: unknown = new Error('Unknown error');

    for (let attempt = 1; attempt <= retries + 1; attempt++) {
        try {
            const response = await request(url, { method: 'GET' }, timeout);
            const text = await response.text();
            if (response.status < 200 || response.status >= 300) {
                throw new NetworkError(
                    `HTTP ${response.status} from ${url.replace(/\?.*$/, '')}`,
                    response.status,
                );
            }
            return JSON.parse(text) as T;
        } catch (cause) {
            lastError = cause;
            if (cause instanceof NetworkError && cause.statusCode >= 400 && cause.statusCode < 500) {
                if (cause.statusCode !== 429) throw cause;
            }
            if (attempt <= retries) {
                opts.onRetry?.(
                    cause instanceof Error ? cause.message : String(cause),
                    attempt,
                    retries,
                );
                await sleep(2 ** (attempt - 1) * 800);
            }
        }
    }

    throw lastError instanceof Error ? lastError : new NetworkError(String(lastError));
}

/** What a download reports, so the caller can draw progress its own way. */
export interface DownloadProgress {
    /** Bytes received so far. */
    received: number;
    /** Total bytes, or null when the server does not say. */
    total: number | null
    /** Round percentage, or null with no total. */
    percent: number | null;
}

/** Streams a URL into a file, with retries and throttled progress. */
export async function downloadFile(
    url: string,
    dest: string,
    opts: {
        timeout?: number;
        retries?: number;
        onProgress?: (progress: DownloadProgress) => void;
    } = {},
): Promise<void> {
    const retries = opts.retries ?? 2;
    const timeout = opts.timeout ?? 120_000;
    let lastError: unknown;

    for (let attempt = 1; attempt <= retries + 1; attempt++) {
        try {
            const response = await request(url, { method: 'GET' }, timeout);
            if (!response.ok) throw new HttpError(response.status, `HTTP ${response.status}`);
            if (!response.body) throw new NetworkError('Empty response body');

            const total =
                Number(response.headers.get('content-length')) > 0
                    ? Number(response.headers.get('content-length'))
                    : null;

            let received = 0;
            let lastTick = 0;
            const report = () => {
                opts.onProgress?.({
                    received,
                    total,
                    percent: total ? Math.min(100, Math.round((received / total) * 100)) : null,
                });
            };

            const source = Readable.fromWeb(response.body as unknown as NodeWebReadableStream);
            source.on('data', (chunk: Buffer) => {
                received += chunk.length;
                // throttled to every percent of progress, or ~1 MiB blind:
                // drawing a bar faster than the eye reads it is jank, not detail
                if (total) {
                    const percent = Math.round((received / total) * 100);
                    if (percent !== lastTick) {
                        report();
                        lastTick = percent;
                    }
                } else if (received - lastTick > 1024 * 1024) {
                    report();
                    lastTick = received;
                }
            });

            await pipeline(source, createWriteStream(dest));
            report();
            return;
        } catch (cause) {
            lastError = cause;
            if (cause instanceof NetworkError && cause.statusCode >= 400 && cause.statusCode < 500) {
                if (cause.statusCode !== 429) throw cause;
            }
            if (attempt <= retries) {
                await sleep(2 ** (attempt - 1) * 800);
            }
        }
    }

    throw lastError instanceof Error ? lastError : new NetworkError(String(lastError));
}
