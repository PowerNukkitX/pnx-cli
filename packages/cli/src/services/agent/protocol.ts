import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { BodyInit } from 'undici-types';
import { readJson, writeJson, removeFile } from '../../infra/store.js';

/**
 * The wire between this CLI and a PowerNukkitX hub.
 *
 * Everything here is outbound: the hub never opens a connection to this
 * machine, so no port is exposed and no firewall rule is needed - when the hub
 * has work, this process is already holding a request open waiting for it.
 *
 * Protocol version 3. Nothing here invents a field: every shape is one the hub
 * validates, and a field it does not know is dropped silently rather than
 * refused, which is how a typo here becomes a feature that quietly never
 * worked.
 */

const PROTOCOL_VERSION = 3;
const SESSION_FILE = 'agent.json';
const REQUEST_TIMEOUT_MS = 20_000;
/** Longer than the hub's 25 s park, or every poll would look like a timeout. */
const POLL_TIMEOUT_MS = 40_000;
export const MAX_BLOB_BYTES = 8 * 1024 * 1024;

/** The nine permissions the hub knows, in the order it lists them. */
export const CAPABILITY_NAMES = [
    'console', 'players', 'worlds', 'config',
    'files', 'plugins', 'backups', 'schedules', 'control',
] as const;

export type CapabilityName = (typeof CAPABILITY_NAMES)[number];
export type Capabilities = Record<CapabilityName, boolean>;

export interface Session {
    hub: string;
    serverId: string;
    token: string;
    serverDir?: string;
    memory?: string;
    autoStart?: boolean;
    capabilities?: Capabilities;
}

interface Envelope {
    version: number;
    nonce: string;
    sentAt: number;
}

function envelope(): Envelope {
    // a fresh nonce per message: the hub uses it to drop a retry whose first
    // attempt died mid-flight, so reusing one would drop a real report
    return { version: PROTOCOL_VERSION, nonce: randomUUID(), sentAt: Date.now() };
}

export async function loadSession(): Promise<Session | null> {
    return readJson<Session | null>(SESSION_FILE, null);
}

export async function saveSession(session: Session): Promise<void> {
    await writeJson(SESSION_FILE, session);
}

export async function clearSession(): Promise<void> {
    await removeFile(SESSION_FILE);
}

/**
 * What a refusal means, in words an operator can act on.
 *
 * The hub answers every failure with a `code` for branching and an `error`
 * sentence for reading. Branching here and writing our own sentence keeps the
 * advice specific: "check hub-url" is useful on this machine and meaningless in
 * a browser.
 */
function explain(status: number, body: Record<string, unknown> | null): string {
    const code = String(body?.code ?? '');
    switch (code) {
        case 'PAIRING_EXPIRED':
            return 'That code has expired or was already used. Generate a new one in the dashboard.';
        case 'CLOCK_AHEAD':
        case 'CLOCK_BEHIND':
            return "This machine's clock is more than five minutes off the hub's. Fix the clock, then pair again.";
        case 'TOKEN_REVOKED':
            return 'This token was replaced. Pair again.';
        case 'UNKNOWN_TOKEN':
            return 'The hub has no server for this token. It was unlinked; run `pnx link --forget`.';
        case 'RATE_LIMITED':
            return 'The hub is rate limiting this address. Wait a minute.';
        case 'LIMIT_REACHED':
            return 'That account has already linked its maximum number of servers.';
        default:
            return String(body?.detail ?? body?.error ?? `The hub answered HTTP ${status}.`);
    }
}

export class HubError extends Error {
    readonly code: string;
    readonly status: number;

    constructor(message: string, code = 'HTTP', status = 0) {
        super(message);
        this.name = 'HubError';
        this.code = code;
        this.status = status;
    }

    /** True when retrying will never help, so a loop should stop rather than spin. */
    get fatal(): boolean {
        return this.code === 'UNKNOWN_TOKEN';
    }
}

async function call(
    url: string,
    init: RequestInit,
    timeoutMs: number,
): Promise<Record<string, any> | null> {
    let response: Response;
    try {
        response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (cause) {
        // an aborted request and an unreachable host are the same thing here:
        // nothing came back, try later
        throw new HubError(`Could not reach ${url}: ${cause instanceof Error ? cause.message : cause}`, 'UNREACHABLE', 0);
    }

    const text = await response.text();
    let body: Record<string, unknown> | null = null;
    try {
        body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
        // a hub behind a captive portal answers HTML; the status still says what
        // happened and the body is not worth guessing at
    }

    if (!response.ok) throw new HubError(explain(response.status, body), String(body?.code ?? 'HTTP'), response.status);
    return (body?.data as Record<string, any> | undefined) ?? null;
}

/** Trades a pairing code for a token. All nine capabilities, always. */
export async function enroll(
    hub: string,
    code: string,
    agent: {
        capabilities: Capabilities;
        environment: Record<string, unknown>;
        serverName?: string;
        agentVersion: string;
    },
): Promise<{ serverId: string; token: string }> {
    const data = await call(
        `${hub}/api/agent/enroll`,
        {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'user-agent': 'pnx-cli' },
            body: JSON.stringify({
                ...envelope(),
                agentVersion: agent.agentVersion,
                capabilities: agent.capabilities,
                code: code.trim().toUpperCase(),
                environment: agent.environment,
                ...(agent.serverName ? { serverName: agent.serverName } : {}),
            }),
        },
        REQUEST_TIMEOUT_MS,
    );
    return data as { serverId: string; token: string };
}

/** Says what changed. Every section is optional; sending nothing is legal. */
export async function report(session: Session, reportBody: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return call(
        `${session.hub}/api/agent/report`,
        {
            method: 'POST',
            headers: {
                authorization: `Bearer ${session.token}`,
                'content-type': 'application/json',
                'user-agent': 'pnx-cli',
            },
            body: JSON.stringify({ ...envelope(), ...reportBody }),
        },
        REQUEST_TIMEOUT_MS,
    );
}

/** Collects whatever work is queued; an empty answer is success, not an error. */
export async function pollCommands(session: Session): Promise<Array<{ commandId: string; kind: string; payload: any }>> {
    const data = await call(
        `${session.hub}/api/agent/commands`,
        { headers: { authorization: `Bearer ${session.token}`, 'user-agent': 'pnx-cli' } },
        POLL_TIMEOUT_MS,
    );
    return data?.commands ?? [];
}

/**
 * Leaves bytes the hub asked for, and returns the id to name in the result.
 *
 * The body is the payload itself rather than base64 in a JSON wrapper: base64
 * costs a third more bytes on a path whose whole purpose is bytes.
 */
export async function uploadBlob(
    session: Session,
    bytes: Uint8Array,
    contentType = 'application/octet-stream',
): Promise<string> {
    if (bytes.byteLength > MAX_BLOB_BYTES) {
        throw new HubError(
            `That file is ${Math.round(bytes.byteLength / 1024 / 1024)} MB; the hub accepts at most 8 MB.`,
            'TOO_LARGE',
            0,
        );
    }
    const data = await call(
        `${session.hub}/api/agent/files`,
        {
            method: 'POST',
            headers: {
                authorization: `Bearer ${session.token}`,
                'content-length': String(bytes.byteLength),
                'content-type': contentType,
                'user-agent': 'pnx-cli',
            },
            body: bytes as unknown as BodyInit,
        },
        REQUEST_TIMEOUT_MS,
    );
    return String(data?.blobId);
}

/** Fetches bytes the hub left for us - the other half of a file write. */
export async function downloadBlob(session: Session, blobId: string): Promise<Buffer> {
    const response = await fetch(`${session.hub}/api/agent/blob/${encodeURIComponent(blobId)}`, {
        headers: { authorization: `Bearer ${session.token}`, 'user-agent': 'pnx-cli' },
    });
    if (!response.ok) {
        throw new HubError(`The hub would not hand over ${blobId} (HTTP ${response.status}).`, 'HTTP', response.status);
    }
    return Buffer.from(await response.arrayBuffer());
}
