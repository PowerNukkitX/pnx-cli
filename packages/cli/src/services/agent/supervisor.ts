import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { buildLaunchArgs, findJava, javaEnv } from '../server.js';
import { savePid, clearPid, killProcess, isAlive, loadPid, requestStop, waitForExit } from '../process.js';

/**
 * The JVM, owned rather than observed.
 *
 * `pnx start` spawns the server with `stdio: inherit`, so its console belongs
 * to the terminal. An agent that merely watched a PID file could report that a
 * process exists and nothing more. Owning the child is what makes the rest
 * possible: output arrives on a pipe we read, input goes on a pipe we write,
 * and "is it running" stops being a guess.
 *
 * The cost is stated plainly: while this agent supervises, stopping the agent
 * stops the server.
 */

const LOG_BUFFER = 400;
const MAX_LINES_PER_REPORT = 200;
const GRACEFUL_STOP_MS = 20_000;

/** How the server announces arrivals and departures. Best effort, and said so. */
const JOINED = /^(?:\[.*?\]\s*)?(?:\[[^\]]+\]:?\s*)?(\S+)(?:\[[^\]]*\])? (?:joined the game|logged in)/i;
const LEFT = /^(?:\[.*?\]\s*)?(?:\[[^\]]+\]:?\s*)?(\S+) (?:left the game|logged out|disconnected)/i;
/** What `list` prints back - the authority on who is online. */
const LIST_COUNT = /There are (\d+)(?:\s*\/\s*|\s+of a max(?:imum)? of\s+)(\d+)/i;

export type SupervisorState = 'offline' | 'starting' | 'online' | 'stopping' | 'error';

export interface SupervisorSnapshot {
    state: SupervisorState;
    playerCount: number | null;
    maxPlayers: number | null;
    playerNames: string[];
    uptimeMillis: number | null;
}

/** Result shape every public supervisor verb returns. */
export interface VerbResult {
    ok: boolean;
    detail: string;
}

export interface SupervisorOptions {
    memory?: string;
}

export class Supervisor extends EventEmitter {
    readonly serverDir: string;
    private memory: string;

    private child: ReturnType<typeof spawn> | null = null;
    private state: SupervisorState = 'offline';

    private lines: string[] = [];
    private pending: string[] = [];
    private players = new Set<string>();
    private maxPlayers: number | null = null;
    private playerCount: number | null = null;
    private startedAt: number | null = null;
    private partial = '';

    constructor(serverDir: string, options: SupervisorOptions = {}) {
        super();
        this.serverDir = serverDir;
        this.memory = options.memory ?? '2G';
    }

    snapshot(): SupervisorSnapshot {
        return {
            state: this.state as SupervisorState,
            playerCount: this.playerCount,
            maxPlayers: this.maxPlayers,
            playerNames: [...this.players],
            uptimeMillis: this.startedAt ? Date.now() - this.startedAt : null,
        };
    }

    /** Lines the hub has not been told about yet, oldest first. */
    drainLogLines(): string[] {
        return this.pending.splice(0, MAX_LINES_PER_REPORT);
    }

    /** The scrollback a freshly opened console should show. */
    recentLines(): string[] {
        return [...this.lines];
    }

    private setState(next: SupervisorState): void {
        if (this.state === next) return;
        this.state = next;
        this.emit('state', next);
    }

    private record(line: string): void {
        const text = line.replace(/\r$/, '');
        if (text.length === 0) return;

        this.lines.push(text);
        if (this.lines.length > LOG_BUFFER) this.lines.shift();

        // a crash loop can print thousands of lines a second; keeping them all
        // would turn a broken server into a memory problem, and the hub
        // refuses the report anyway
        if (this.pending.length < MAX_LINES_PER_REPORT * 4) this.pending.push(text);

        const joined = JOINED.exec(text);
        if (joined) {
            this.players.add(joined[1]!);
            this.playerCount = this.players.size;
        }

        const left = LEFT.exec(text);
        if (left) {
            this.players.delete(left[1]!);
            this.playerCount = this.players.size;
        }

        const counted = LIST_COUNT.exec(text);
        if (counted) {
            // the authority: the tracked set was a guess until this line and a
            // fact after it
            this.playerCount = Number(counted[1]);
            this.maxPlayers = Number(counted[2]);
        }

        this.emit('line', text);
    }

    /**
     * Starts the server, or says why it will not.
     *
     * Refuses rather than starting a second one: two JVMs on one world
     * directory corrupt it, and "it was already running" is a success from the
     * caller's point of view anyway.
     */
    async start(): Promise<VerbResult> {
        if (this.child) return { ok: true, detail: 'already running' };

        const existing = await loadPid();
        if (existing && isAlive(existing.pid) && existing.serverPath === this.serverDir) {
            return {
                ok: false,
                detail: `a server is already running on this directory (PID ${existing.pid}); stop it first`,
            };
        }

        this.setState('starting');
        this.players.clear();
        this.playerCount = null;

        const child = spawn(findJava(), buildLaunchArgs(this.memory), {
            cwd: this.serverDir,
            env: javaEnv(),
            // the whole point: pipes rather than inherit, so console in and out
            // belong to this process
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        this.child = child;
        this.startedAt = Date.now();

        if (child.pid) await savePid(child.pid, this.serverDir);

        const onChunk = (chunk: Buffer) => {
            this.partial += chunk.toString('utf8');
            const parts = this.partial.split('\n');
            // the last piece may be half a line still arriving
            this.partial = parts.pop() ?? '';
            for (const part of parts) this.record(part);
        };

        child.stdout?.on('data', onChunk);
        child.stderr?.on('data', onChunk);

        child.on('error', (failure: Error) => {
            this.record(`[agent] could not start java: ${failure.message}`);
            this.child = null;
            this.setState('error');
        });

        child.on('exit', (code: number | null) => {
            const wasStopping = this.state === 'stopping';
            this.child = null;
            this.startedAt = null;
            this.players.clear();
            this.playerCount = null;
            void clearPid();

            // a clean exit is a stop; anything else is the server falling over,
            // and the two must not read the same on a dashboard
            this.record(`[agent] server exited with code ${code ?? '?'}`);
            this.setState(code === 0 || wasStopping ? 'offline' : 'error');
        });

        this.setState('online');
        return { ok: true, detail: `started (PID ${child.pid ?? '?'})` };
    }

    /**
     * Asks the server to stop, and insists if it will not.
     *
     * `stop` on the console lets it save the world and disconnect people with a
     * message. Killing does neither, so it is what happens after twenty
     * seconds rather than what happens first.
     */
    async stop(): Promise<VerbResult> {
        if (!this.child) {
            const existing = await loadPid();
            if (existing && isAlive(existing.pid)) {
                // started by `pnx start`: ask through its console first, so the
                // world is saved; kill only if it will not go
                await requestStop(existing);
                if (!(await waitForExit(existing.pid, GRACEFUL_STOP_MS))) await killProcess(existing.pid);
                await clearPid();
                this.setState('offline');
                return { ok: true, detail: 'stopped a server this agent did not start' };
            }
            return { ok: true, detail: 'already stopped' };
        }

        const child = this.child;
        this.setState('stopping');

        try {
            child.stdin?.write('stop\n');
        } catch {
            // the pipe is already gone, which means so is the process
        }

        const exited = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), GRACEFUL_STOP_MS);
            child.once('exit', () => {
                clearTimeout(timer);
                resolve(true);
            });
        });

        if (exited) return { ok: true, detail: 'stopped' };

        this.record('[agent] server did not stop in 20s, killing it');
        if (child.pid) await killProcess(child.pid);
        await clearPid();
        this.setState('offline');
        return { ok: true, detail: 'killed after refusing to stop' };
    }

    async restart(): Promise<VerbResult> {
        const stopped = await this.stop();
        if (!stopped.ok) return stopped;
        return this.start();
    }

    /**
     * Writes one line to the server console.
     *
     * Written as one line with nothing appended, so there is no way for it to
     * become two commands.
     */
    sendConsole(line: string): VerbResult {
        if (!this.child) return { ok: false, detail: 'the server is not running' };
        if (typeof line !== 'string' || /[\r\n]/.test(line)) {
            return { ok: false, detail: 'a console line may not contain a newline' };
        }
        try {
            this.child.stdin?.write(`${line}\n`);
            return { ok: true, detail: 'sent' };
        } catch (cause) {
            return { ok: false, detail: `could not write to the server: ${cause instanceof Error ? cause.message : cause}` };
        }
    }

    /**
     * Asks the server who is online and waits briefly for the answer.
     *
     * Resolves on the count line, or gives up - a server that does not answer
     * `list` is not one this agent can describe, and saying nothing beats
     * saying zero.
     */
    async probePlayers(timeoutMs = 3000): Promise<VerbResult> {
        if (!this.child) return { ok: false, detail: 'the server is not running' };

        const sent = this.sendConsole('list');
        if (!sent.ok) return sent;

        const answered = await new Promise<boolean>((resolve) => {
            const watch = (text: string) => {
                if (!LIST_COUNT.test(text)) return;
                clearTimeout(timer);
                this.off('line', watch);
                resolve(true);
            };
            const timer = setTimeout(() => {
                this.off('line', watch);
                resolve(false);
            }, timeoutMs);
            this.on('line', watch);
        });

        return answered
            ? { ok: true, detail: `${this.playerCount ?? '?'} online` }
            : { ok: false, detail: 'the server did not answer `list`' };
    }
}
