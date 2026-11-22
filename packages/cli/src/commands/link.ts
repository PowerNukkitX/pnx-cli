import { keyValue, log, introHead, outroTail, note, spinner, askText } from '../ui/kit.js';
import { c } from '../ui/theme.js';
import { VERSION } from '../infra/version.js';
import { resolveServerDir, checkJava } from '../services/server.js';
import { runCommand, type CommandContext } from '../services/agent/jobs.js';
import { Supervisor } from '../services/agent/supervisor.js';
import {
    CAPABILITY_NAMES,
    clearSession,
    enroll,
    HubError,
    loadSession,
    pollCommands,
    report,
    saveSession,
    type Capabilities,
    type Session,
} from '../services/agent/protocol.js';

/**
 * Links this server to a hub, and then keeps it linked.
 *
 * Everything the dashboard offers beyond a green dot needs the server's own
 * input and output: a console to read, a console to write to, a `list` to ask.
 * `pnx start` gives those to the terminal it was run from, so an agent started
 * separately could only ever report that a PID exists.
 *
 * So this command is the supervisor. It starts the JVM, holds both pipes, and
 * reports what it sees. Two loops, never one: the command channel parks for
 * twenty-five seconds by design, and sharing a timer with the reporter would
 * make the dashboard go quiet for those same twenty-five seconds every time
 * somebody pressed a button on it.
 */

/** What a fresh pairing turns on. The rest is opt-in, by name. */
const DEFAULT_ALLOWED = ['console', 'control'];

export interface LinkOptions {
    code?: string;
    hub?: string;
    allow?: string;
    dir?: string;
    memory?: string;
    name?: string;
    start?: boolean;
    status?: boolean;
    forget?: boolean;
    pairOnly?: boolean;
}

function capabilitiesFrom(list?: string): Capabilities {
    const wanted = new Set(
        String(list ?? DEFAULT_ALLOWED.join(','))
            .split(',')
            .map((name) => name.trim().toLowerCase())
            .filter(Boolean),
    );
    const unknown = [...wanted].find((name) => !(CAPABILITY_NAMES as readonly string[]).includes(name));
    if (unknown) {
        throw new Error(`unknown capability: ${unknown}. Known: ${CAPABILITY_NAMES.join(', ')}`);
    }
    // all nine, always: an omitted name would be ambiguous between "this agent
    // is older than the capability" and "the operator turned it off"
    return Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, wanted.has(name)])) as Capabilities;
}

async function describeEnvironment(serverDir: string): Promise<Record<string, unknown>> {
    const java = await checkJava();
    return {
        javaVersion: java.ok ? String(java.version) : null,
        os: `${process.platform} ${process.arch}`,
        pnxCli: {
            binary: process.argv[1] ?? 'pnx',
            commands: ['start', 'stop', 'backup', 'plugin'],
            present: true,
            version: VERSION,
        },
        port: null,
        powernukkitxVersion: null,
        serverDir,
    };
}

/** What one report carries. Absent sections mean "unchanged", not "zero". */
function reportBody(
    supervisor: Supervisor,
    options: { capabilities: Capabilities; facts: Record<string, unknown>; firstReport: boolean },
): Record<string, unknown> {
    const snapshot = supervisor.snapshot();
    const body: Record<string, unknown> = { state: snapshot.state };

    // metrics only once a `list` has answered: the player count is the one
    // number a supervisor can state, and a zero before then would draw an
    // empty server on a dashboard, which is a lie with a graph attached
    if (snapshot.playerCount !== null) {
        const metrics: Record<string, number> = { players: snapshot.playerCount };
        if (snapshot.maxPlayers !== null) metrics.maxPlayers = snapshot.maxPlayers;
        if (snapshot.uptimeMillis !== null) metrics.uptimeMillis = snapshot.uptimeMillis;
        body.metrics = metrics;
        // no `tps`: it lives inside the JVM, and this process is outside it
    }

    if (snapshot.playerNames.length > 0) body.playerNames = snapshot.playerNames;

    if (options.capabilities.console) {
        const lines = supervisor.drainLogLines();
        if (lines.length > 0) body.logLines = lines;
    }

    // the machine's description does not change between reports, so it
    // travels once rather than on every tick
    if (options.firstReport) body.facts = options.facts;

    return body;
}

export async function runLink(options: LinkOptions): Promise<void> {
    const existing = await loadSession();

    if (options.forget) {
        await clearSession();
        log.success('Forgotten. This machine no longer holds a token for any hub.');
        return;
    }

    if (options.status) {
        introHead('pnx link', 'dashboard pairing');
        if (!existing) {
            log.warn('This machine is not linked to any hub.');
            outroTail('Get a code from the dashboard, then run `pnx link <code>`.');
            return;
        }
        const on = CAPABILITY_NAMES.filter((name) => existing.capabilities?.[name]);
        keyValue(
            {
                Hub: c.brand(existing.hub),
                Server: existing.serverId,
                Directory: existing.serverDir ?? c.muted('resolved at launch'),
                Allowed: on.length > 0 ? on.join(', ') : c.muted('nothing'),
            },
            'Linked',
        );
        outroTail('Start supervising with `pnx link`.');
        return;
    }

    const serverDir = options.dir ?? (await resolveServerDir());
    if (!serverDir) {
        log.error('No PowerNukkitX server found here. Run `pnx init`, or pass --dir.');
        return;
    }

    let session = existing as Session | null;

    if (options.code) {
        introHead('pnx link', 'pairing');
        const sp = spinner();
        sp.start('Exchanging the code for a token...');

        try {
            const capabilities = capabilitiesFrom(options.allow);
            const granted = await enroll(options.hub ?? 'https://powernukkitx.org', options.code, {
                agentVersion: `pnx-cli/${VERSION}`,
                capabilities,
                environment: await describeEnvironment(serverDir),
                serverName: options.name,
            });

            session = {
                autoStart: options.start !== false,
                capabilities,
                hub: options.hub ?? 'https://powernukkitx.org',
                memory: options.memory,
                serverDir,
                serverId: granted.serverId,
                token: granted.token,
            };
            await saveSession(session);
            sp.stop('Paired');

            const on = CAPABILITY_NAMES.filter((name) => capabilities[name]);
            note(
                `${c.muted('Hub')}      ${c.brand(options.hub ?? '')}\n${c.muted('Server')}    ${granted.serverId}\n${c.muted('Allowed')}   ${on.length > 0 ? on.join(', ') : c.muted('nothing')}`,
                'Linked',
            );
            log.message(c.muted('The token is in ~/.pnx-cli/agent.json. Treat it like a password.'));
        } catch (cause) {
            sp.error(cause instanceof HubError ? cause.message : String(cause instanceof Error ? cause.message : cause));
        }
    }

    if (!session) {
        log.error('Not linked yet. Run `pnx link <code>` with a code from the dashboard.');
        return;
    }

    if (options.pairOnly) {
        log.message(c.muted('Run `pnx link` to start supervising this server.'));
        return;
    }

    // a stored session may predate the options this run was given
    session.serverDir = serverDir;
    if (options.memory) session.memory = options.memory;
    if (options.start !== undefined) session.autoStart = options.start;

    await runAgent(session);
}

async function runAgent(session: Session): Promise<void> {
    const supervisor = new Supervisor(session.serverDir!, { memory: session.memory });
    const capabilities = session.capabilities ?? ({} as Capabilities);
    const context: CommandContext = { capabilities, serverDir: session.serverDir!, session, supervisor };

    log.info(`Reporting to ${session.hub} as ${session.serverId}`);
    log.info('This process is now the server supervisor. Stopping it stops the server.');

    if (session.autoStart !== false) {
        const started = await supervisor.start();
        if (started.ok) log.success(started.detail);
        else log.error(started.detail);
    }

    const facts = await describeEnvironment(session.serverDir!);
    let first = true;
    let interval = 30;
    let stopping = false;

    // a clean shutdown stops the server rather than orphaning it: Ctrl-C
    // killing the supervisor alone would leave a JVM running with nobody
    // holding its pipes, unreachable and in the way of the next `pnx link`
    const shutdown = async () => {
        if (stopping) return;
        stopping = true;
        log.info('Stopping the server before exiting...');
        await supervisor.stop();
        process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());

    const reportOnce = async () => {
        const body = reportBody(supervisor, { capabilities, facts, firstReport: first });
        const ack = await report(session, body);
        first = false;
        const seconds = ack?.intervalSeconds;
        if (typeof seconds === 'number') interval = seconds;
    };

    // scheduled after each report rather than on a fixed timer: the hub asks
    // for several reports a second while the dashboard is open and one every
    // thirty seconds otherwise, and says which on every answer
    const reporting = (async () => {
        while (!stopping) {
            try {
                await reportOnce();
            } catch (cause) {
                if (cause instanceof HubError && cause.fatal) {
                    log.error(cause.message);
                    await shutdown();
                    return;
                }
                log.warn(cause instanceof Error ? cause.message : String(cause));
            }
            await new Promise((resolve) => setTimeout(resolve, Math.max(1, interval) * 1000));
        }
    })();
    void reporting;

    for (;;) {
        if (stopping) return;

        try {
            const commands = await pollCommands(session);
            if (commands.length === 0) continue;

            const results = [];
            for (const command of commands) {
                log.step(`${command.kind}: ${JSON.stringify(command.payload)}`);
                results.push(await runCommand(context, command));
            }

            // command results ride a report of their own rather than waiting
            // for the next tick: somebody pressed a button and is watching
            await report(session, { commandResults: results, state: supervisor.snapshot().state });
        } catch (cause) {
            if (cause instanceof HubError && cause.fatal) {
                log.error(cause.message);
                await shutdown();
                return;
            }
            log.warn(cause instanceof Error ? cause.message : String(cause));
            await new Promise((resolve) => setTimeout(resolve, 5000));
        }
    }
}

/**
 * Interactive pairing - the menu path. Prompts for the code and hub, pairs, and
 * returns, so a user landing back in the list is not looking at a terminal
 * hijacked by a supervisor.
 */
export async function pairInteractively(serverDir: string | null): Promise<void> {
    const code = await askText({ message: 'Pairing code (shown on the dashboard)' });
    const hubRaw = await askText({
        message: 'Dashboard address',
        placeholder: 'https://powernukkitx.org',
        defaultValue: 'https://powernukkitx.org',
    });
    await runLink({
        code: String(code),
        dir: serverDir ?? undefined,
        hub: String(hubRaw).replace(/\/$/, ''),
        pairOnly: true,
    });
}
