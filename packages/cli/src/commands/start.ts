import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { randomBytes } from 'node:crypto';
import { platform } from 'node:os';
import { CliError, readString, readBool, type RunContext } from '../cli/define.js';
import { askConfirm, banner, duration, nextSteps, outroTail, spinner, isInteractive, type SpinnerLike } from '../ui/kit.js';
import { c, S } from '../ui/theme.js';
import { resolveServerDir, checkJava, findJava, buildLaunchArgs, javaEnv, parseMemory, MIN_JAVA } from '../services/server.js';
import { savePid, clearPid, loadPid, isAlive, killProcess } from '../services/process.js';
import { serverPort } from '../services/config-file.js';
import { JAR_NAME } from '../infra/paths.js';
import { jarVersion } from '../infra/jar.js';
import { runCreate, printCreateSummary } from './create.js';
import { lanAddresses } from './status.js';

/**
 * Starting the server, in the foreground - the way `next dev` starts an app.
 *
 * A header says what runs and where to connect (`- Local:`, `- Network:`),
 * the boot is one spinner instead of forty log lines, and `✓ Ready in 3.4s`
 * marks the moment players can join. Errors during the boot still print as
 * they happen, warnings are counted, and a failed boot dumps the log tail, so
 * nothing is hidden that matters. `--verbose`, a pipe or a service manager get
 * the raw stream, untouched.
 *
 * Input goes through this process, which is what makes a clean stop possible:
 * - typing here reaches the server console as usual;
 * - Ctrl+C types `stop` (the world is saved), a second Ctrl+C forces it;
 * - `pnx stop` / `pnx cmd` in another terminal talk to a control socket on
 *   127.0.0.1, guarded by a token stored in the PID record.
 */

export interface StartOptions {
    dir?: string;
    memory?: string;
    restart?: boolean;
    dryRun?: boolean;
    /** stream the whole boot log instead of the spinner */
    verbose?: boolean;
}

/** Strips ANSI and Minecraft `§` colour codes: what the line says, not how. */
const plain = (line: string): string => line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/§[0-9a-fk-or]/gi, '');

/**
 * What a log line says, without its stamp: both the console form
 * (`15:20:42 [main] [INFO] Loading recipes...`) and the file form
 * (`... [main] INFO - Loading recipes...`) become `Loading recipes...`.
 * The JVM's own `Picked up JAVA_TOOL_OPTIONS` notice says nothing to a person.
 */
const message = (line: string): string => {
    if (/^Picked up JAVA_TOOL_OPTIONS/.test(line)) return '';
    return line.replace(/^.*?\b(?:INFO|WARN|ERROR|DEBUG|FATAL)\]?\s*-?\s*/, '').trim();
};

const READY = /\bDone \(([\d.,]+)s\)!/;
const BOOT_TAIL = 30;

const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 10 * 60 * 1000;

/** Runs the server until it stops; resolves with its exit code (0 when it stopped cleanly). */
export async function runStart(options: StartOptions): Promise<number> {
    const serverPath = options.dir ? resolve(options.dir) : ((await resolveServerDir()) ?? process.cwd());

    const memory = parseMemory(options.memory ?? '2G');
    if (!memory) {
        throw new CliError(`\`${options.memory}\` is not a memory size.`, 'Use a size such as 2G, 4G or 3072M (at least 512M).');
    }

    if (!existsSync(resolve(serverPath, JAR_NAME))) {
        if (isInteractive() && (await askConfirm(`No ${JAR_NAME} in ${serverPath}. Create a server there?`, true))) {
            const result = await runCreate({ dir: serverPath });
            printCreateSummary(result);
            return 0;
        }
        nextSteps([
            ['pnx init', 'create a server here'],
            ['pnx use <path>', 'or point at one that exists elsewhere'],
        ], 'Try');
        outroTail(`No ${JAR_NAME} in ${serverPath}.`, 'fail');
        return 1;
    }

    const previous = await loadPid();
    if (previous && isAlive(previous.pid)) {
        nextSteps([['pnx stop', 'stop it first'], ['pnx cmd <command>', 'or talk to it']], 'Try');
        outroTail(`A server is already running (PID ${previous.pid}, ${previous.serverPath}).`, 'fail');
        return 1;
    }

    const sp = spinner();
    sp.start('Checking Java');
    const java = await checkJava();
    if (!java.ok) {
        sp.error(java.version ? `Java ${java.version} is too old` : 'Java not found');
        nextSteps([
            ['https://adoptium.net/', `install Java ${MIN_JAVA} or newer`],
            ['pnx doctor', 'check again afterwards'],
        ], 'Fix');
        outroTail(`PowerNukkitX needs Java ${MIN_JAVA} or newer.`, 'fail');
        return 1;
    }
    sp.clear();

    const javaCommand = [findJava(), ...buildLaunchArgs(memory, java.version), '--nogui'];

    if (options.dryRun) {
        // the line exists to be copied: the exact command, one line, nothing else
        process.stdout.write(`\n${javaCommand.join(' ')}\n\n`);
        return 0;
    }

    let child: ChildProcess | null = null;
    let finish: (code: number) => void = () => undefined;
    const finished = new Promise<number>((resolveFinish) => { finish = resolveFinish; });
    let stopping = false;
    const crashes: number[] = [];

    /* the control socket: one line per connection, "<token> <command>" */
    const token = randomBytes(16).toString('hex');
    const control: Server = createServer((socket) => {
        socket.setEncoding('utf8');
        let buffer = '';
        socket.on('data', (data) => {
            buffer += data;
            const at = buffer.indexOf('\n');
            if (at < 0) return;
            const line = buffer.slice(0, at);
            const space = line.indexOf(' ');
            const ok = space > 0 && line.slice(0, space) === token;
            const command = ok ? line.slice(space + 1).trim() : '';
            if (ok && command && child?.stdin?.writable) {
                if (command === 'stop') stopping = true;
                child.stdin.write(`${command}\n`);
                socket.end('ok\n');
            } else {
                socket.end('refused\n');
            }
        });
        socket.on('error', () => undefined);
    });
    await new Promise<void>((done) => control.listen(0, '127.0.0.1', () => done()));
    const port = (control.address() as { port: number }).port;

    /* ── the header: what runs, and where players connect ─────────────────── */
    const gamePort = serverPort(serverPath);
    const version = jarVersion(resolve(serverPath, JAR_NAME));
    const network = lanAddresses();
    banner('PowerNukkitX', version, [
        ['Local', c.brand(`127.0.0.1:${gamePort}`)],
        ...(network.length ? [['Network', c.brand(`${network[0]}:${gamePort}`)] as [string, string]] : []),
        ['Java', `${java.version}${java.vendor !== 'Unknown' ? ` (${java.vendor})` : ''} ${c.muted(S.bullet)} up to ${memory}`],
        ['Folder', c.muted(serverPath)],
    ]);

    // a person at a terminal gets the spinner; a pipe, a service manager or
    // --verbose get every line, as the server wrote it
    const quiet = Boolean(process.stdout.isTTY) && !options.verbose;

    let ready = false;
    let bootSpinner: SpinnerLike | null = null;
    let bootStartedAt = 0;
    let bootLog: string[] = [];
    let warnings = 0;
    let partial = '';

    const markReady = () => {
        ready = true;
        const took = duration(Date.now() - bootStartedAt);
        const warned = warnings > 0 ? c.muted(`  ${S.bullet} ${warnings} warning${warnings > 1 ? 's' : ''} (pnx logs)`) : '';
        if (bootSpinner) bootSpinner.stop(`Ready in ${took}${warned}`);
        else process.stdout.write(`${c.success(S.check)} Ready in ${took}${warned}\n`);
        bootSpinner = null;
        if (quiet) {
            process.stdout.write(c.muted(`  Type a server command here ${S.bullet} Ctrl+C or \`pnx stop\` saves and stops\n\n`));
        }
    };

    const onBootLine = (raw: string) => {
        const line = plain(raw);
        bootLog.push(raw);
        if (bootLog.length > BOOT_TAIL) bootLog = bootLog.slice(-BOOT_TAIL);
        if (/\bWARN\b/.test(line)) warnings++;
        if (quiet && /\b(ERROR|FATAL|SEVERE)\b/.test(line)) bootSpinner?.print(`${c.error(S.cross)} ${message(line)}`);
        if (quiet && bootSpinner) {
            const width = Math.max(20, (process.stdout.columns ?? 80) - 18);
            const said = message(line);
            if (said) bootSpinner.message(`Starting${S.ellipsis} ${c.muted(said.length > width ? `${said.slice(0, width - 1)}${S.ellipsis}` : said)}`);
        }
        if (READY.test(line)) markReady();
    };

    const onOutput = (stream: NodeJS.WriteStream) => (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        if (ready) {
            stream.write(text);
            return;
        }
        if (!quiet) stream.write(text);
        partial += text;
        const lines = partial.split(/\r?\n/);
        partial = lines.pop() ?? '';
        for (let index = 0; index < lines.length; index++) {
            onBootLine(lines[index]!);
            if (ready) {
                // the rest of this chunk belongs to the live console, in order
                const rest = lines.slice(index + 1);
                if (quiet) stream.write(`${rest.length ? `${rest.join('\n')}\n` : ''}${partial}`);
                partial = '';
                break;
            }
        }
    };

    const launch = () => {
        ready = false;
        warnings = 0;
        bootLog = [];
        partial = '';
        bootStartedAt = Date.now();
        child = spawn(javaCommand[0]!, javaCommand.slice(1), {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: javaEnv(),
            cwd: serverPath,
            // its own process group on Linux/macOS: Ctrl+C reaches this process
            // only, which turns it into `stop` instead of a killed JVM
            detached: platform() !== 'win32',
        });
        child.stdin?.on('error', () => undefined);
        child.stdout?.on('data', onOutput(process.stdout));
        child.stderr?.on('data', onOutput(process.stderr));
        if (child.pid) void savePid(child.pid, serverPath, { port, token });
        if (quiet) {
            bootSpinner = spinner();
            bootSpinner.start(`Starting${S.ellipsis}`);
        }
        child.on('exit', (code, signal) => {
            const crashed = !stopping && code !== 0;
            if (!ready) {
                if (bootSpinner) {
                    if (stopping) bootSpinner.clear();
                    else bootSpinner.error(`Failed to start ${c.muted(`(exit code ${code ?? signal})`)}`);
                }
                bootSpinner = null;
                // a boot that failed quietly owes its reader the lines that explain it
                if (quiet && !stopping && bootLog.length) {
                    process.stdout.write(`\n${c.muted(`Last ${bootLog.length} lines of the server log:`)}\n${bootLog.join('\n')}${partial ? `\n${partial}` : ''}\n`);
                }
            }
            if (crashed && options.restart) {
                const now = Date.now();
                crashes.push(now);
                while (crashes.length && now - crashes[0]! > RESTART_WINDOW_MS) crashes.shift();
                if (crashes.length <= MAX_RESTARTS) {
                    process.stdout.write(`\n${c.warn(S.warn)} Exited with code ${code ?? signal} - restarting in 5 s (${crashes.length}/${MAX_RESTARTS})\n`);
                    setTimeout(launch, 5000);
                    return;
                }
                process.stdout.write(`\n${c.error(S.cross)} Crashed ${MAX_RESTARTS} times in 10 minutes - not restarting again.\n`);
            }
            control.close();
            process.stdin.off('data', forward);
            process.stdin.pause();
            process.off('SIGINT', onInterrupt);
            process.off('SIGTERM', onInterrupt);
            if (onHangup) process.off('SIGHUP', onHangup);
            void clearPid().finally(() => {
                if (crashed) outroTail(`Server crashed (exit code ${code ?? signal}).`, 'fail');
                else outroTail('Server stopped.', 'ok');
                finish(crashed ? 1 : 0);
            });
        });
    };

    // what is typed here goes to the server console; the end of our stdin
    // (a pipe, a closed terminal) must not close the server's
    const forward = (data: Buffer | string) => {
        if (child?.stdin?.writable) child.stdin.write(data);
    };
    process.stdin.on('data', forward);
    process.stdin.resume();

    // a line said over a running spinner goes above it, not through it
    const say = (line: string) => {
        if (bootSpinner) bootSpinner.print(line);
        else process.stdout.write(`\n${line}\n`);
    };
    let interrupts = 0;
    const onInterrupt = () => {
        interrupts++;
        if (interrupts === 1 && child?.stdin?.writable) {
            stopping = true;
            say(c.muted('Stopping - saving the world. Press Ctrl+C again to force.'));
            child.stdin.write('stop\n');
            return;
        }
        say(c.warn('Forcing the server to stop.'));
        if (child?.pid) void killProcess(child.pid);
    };
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onInterrupt);
    // the terminal closing must not orphan a detached server mid-save
    const onHangup = platform() !== 'win32' ? () => { interrupts = 0; onInterrupt(); } : null;
    if (onHangup) process.on('SIGHUP', onHangup);

    launch();
    return finished;
}

export async function startCommand(ctx: RunContext): Promise<void> {
    process.exitCode = await runStart({
        dir: readString(ctx.args, 'dir') ?? ctx.args.positionals[0],
        memory: readString(ctx.args, 'memory'),
        restart: readBool(ctx.args, 'restart'),
        dryRun: readBool(ctx.args, 'dry-run'),
        verbose: readBool(ctx.args, 'verbose'),
    });
}
