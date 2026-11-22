import {
    confirm as promptConfirm,
    multiselect as promptMulti,
    select as promptSelect,
    text as promptText,
    type SelectOptions,
    type TextOptions,
} from './prompt.js';
import { json } from '../infra/json.js';
import { c, gradient, S } from './theme.js';

/**
 * How every command speaks: one rail, top to bottom.
 *
 * A run opens with `┌  pnx backup`, every fact and question hangs off a
 * `│` rail, each finished step leaves a `◇`, a running one spins in place
 * (`◒ ◐ ◓ ◑`), and the run closes with `└  ✓ Done in 1.2s`. It is the shape
 * clack and create-astro made familiar: a reader can scroll back and see the
 * whole story of a command as a list of steps, and the eye always knows where
 * one run ends and the next begins.
 *
 * Everything printed goes through here, so `--json` runs print nothing but
 * their JSON, and piped runs get the same lines without colour.
 */

/** A [command, reason] pair: what to run next, and what it is for. */
export type Hint = [string, string?];

let railOpen = false;
/** Whether the last thing on the rail was a bare `│` gap, so gaps never double. */
let lastGap = false;

/** True between a run's `┌` and its `└`. */
export function railIsOpen(): boolean {
    return railOpen;
}

const write = (text: string): void => {
    if (!json.isJson()) process.stdout.write(text);
};

/** A line on the rail: `│  text`, or a bare `│` for a gap. */
const out = (line = ''): void => {
    if (json.isJson()) return;
    if (!railOpen) { process.stdout.write(`${line}\n`); return; }
    if (!line && lastGap) return;
    lastGap = !line;
    process.stdout.write(line ? `${c.muted(S.rail)}  ${line}\n` : `${c.muted(S.rail)}\n`);
};

/** A line whose first column is a step mark instead of the rail: `◇  text`. */
const mark = (symbol: string, text: string): void => {
    if (json.isJson()) return;
    lastGap = false;
    process.stdout.write(`${symbol}  ${text}\n`);
};

/** Pads a string that may contain colour codes to a visible width. */
function pad(text: string, width: number): string {
    return text + ' '.repeat(Math.max(0, width - c.strip(text).length));
}

const columns = (): number => Math.max(40, process.stdout.columns || 80);

/* ── timing ──────────────────────────────────────────────────────────────── */

let runStarted = Date.now();

/** A duration the way build tools say it: `840ms`, `3.4s`, `1m 12s`. */
export function duration(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** Time since the current run began. */
export function elapsed(): string {
    return duration(Date.now() - runStarted);
}

/* ── the frame of a run ──────────────────────────────────────────────────── */

/** Opens a run: `┌  pnx  doctor  can this server start today?` */
export function introHead(title: string, subtitle?: string): void {
    runStarted = Date.now();
    if (json.isJson()) return;
    if (railOpen) out();
    const [tool, ...rest] = title.split(' ');
    const name = rest.length ? `${c.badge(tool ?? 'pnx')} ${c.bold(rest.join(' '))}` : c.badge(title);
    process.stdout.write(`\n${c.muted(S.railTop)}  ${name}${subtitle ? `  ${c.muted(subtitle)}` : ''}\n`);
    railOpen = true;
    out();
}

/**
 * The framework-style header (`▲ Next.js 15` and its `- Local:` rows): the
 * product and its version on one line, then the facts somebody came to copy.
 * It stands outside the rail: what follows is the server's own console.
 */
export function banner(title: string, version: string | null, rows: Array<[string, string]>): void {
    runStarted = Date.now();
    railOpen = false;
    const width = Math.max(0, ...rows.map(([key]) => key.length + 1));
    write('\n');
    write(`  ${c.brand(S.logo)} ${c.bold(gradient(title))}${version ? ` ${c.bold(version)}` : ''}\n`);
    for (const [key, value] of rows) write(`  ${c.muted('-')} ${`${key}:`.padEnd(width)}  ${value}\n`);
    write('\n');
}

/**
 * Closes a run, and is the only place its outcome is said.
 * `fail` also sets the exit code, so a script reading `$?` hears the same.
 * A success that took noticeable time says how long, as build tools do.
 */
export function outroTail(message?: string, tone: 'ok' | 'fail' | 'info' = 'info'): void {
    if (tone === 'fail') process.exitCode = 1;
    if (json.isJson()) return;
    const took = Date.now() - runStarted;
    let text = '';
    if (message) {
        if (tone === 'ok') {
            text = took >= 1000
                ? `${c.success(S.check)} ${message.replace(/\.$/, '')} ${c.muted(`in ${duration(took)}`)}`
                : `${c.success(S.check)} ${message}`;
        } else if (tone === 'fail') {
            text = `${c.error(S.cross)} ${message}`;
        } else {
            text = c.muted(message);
        }
    }
    if (railOpen) {
        process.stdout.write(`${lastGap ? '' : `${c.muted(S.rail)}\n`}${c.muted(S.railEnd)}  ${text}\n\n`);
        railOpen = false;
        return;
    }
    process.stdout.write(text ? `\n${text}\n\n` : '\n');
}

/** Closes an open rail on an error that is printed elsewhere (stderr). */
export function closeRailWithError(message: string, hint?: string): boolean {
    if (!railOpen || json.isJson()) return false;
    railOpen = false;
    process.stderr.write(`${c.muted(S.rail)}\n${c.error(S.stepError)}  ${message}\n`);
    process.stderr.write(`${c.muted(S.railEnd)}  ${hint ? c.muted(hint) : ''}\n\n`);
    return true;
}

/** Kept for the launcher: a one-line brand head and aligned facts. */
export function launcherCard(rows: Array<[string, string]>, right: string): void {
    runStarted = Date.now();
    write(`\n${c.muted(S.railTop)}  ${c.badge('pnx')} ${c.bold('create')}${right ? c.muted(`  ${right}`) : ''}\n`);
    railOpen = true;
    out();
    const width = Math.max(...rows.map(([key]) => key.length));
    for (const [key, value] of rows) out(`${c.muted(key.padEnd(width))}  ${value}`);
    out();
}

/* ── prompts ─────────────────────────────────────────────────────────────── */

export { CancelledError } from './prompt.js';
export type { Choice, Heading, SelectItem } from './prompt.js';

/** Text entry; Esc or Ctrl+C becomes a CancelledError. */
export async function askText(opts: TextOptions): Promise<string> {
    return promptText(opts);
}

/** Pick one from a list. */
export async function askSelect<T>(opts: SelectOptions<T>): Promise<T> {
    return promptSelect(opts);
}

/** Yes or no. */
export async function askConfirm(message: string, initialValue = false): Promise<boolean> {
    return promptConfirm(message, initialValue);
}

/** Pick many; everything chosen, in list order. */
export async function askMulti<T>(
    opts: { message: string; options: Array<{ value: T; label?: string; hint?: string }>; required?: boolean; maxItems?: number },
): Promise<T[]> {
    return promptMulti({
        message: opts.message,
        maxItems: opts.maxItems,
        options: opts.options.map((option) => ({ ...option, label: option.label ?? String(option.value) })),
    });
}

/* ── blocks of facts ─────────────────────────────────────────────────────── */

/**
 * A titled card, clack's `note`:
 *
 *   ◇  Backup created ─────────╮
 *   │                          │
 *   │  Location  backups/...   │
 *   │                          │
 *   ├──────────────────────────╯
 *
 * Too wide for the terminal, it falls back to plain lines on the rail.
 */
export function note(message: string, title?: string): void {
    if (json.isJson()) return;
    const lines = String(message).split('\n');
    const inner = Math.max(c.strip(title ?? '').length + 2, ...lines.map((line) => c.strip(line).length)) + 2;
    if (!railOpen || inner + 6 > columns()) {
        if (title) {
            if (railOpen) mark(c.success(S.stepDone), c.bold(title));
            else out(c.bold(title));
        }
        for (const line of lines) out(railOpen ? line : `  ${line}`);
        out();
        return;
    }
    const bar = c.muted(S.rail);
    const head = title ? `${c.bold(title)} ` : '';
    const fill = S.hline.repeat(Math.max(1, inner - c.strip(head).length));
    process.stdout.write(`${c.success(S.stepDone)}  ${head}${c.muted(`${fill}${S.cornerTR}`)}\n`);
    process.stdout.write(`${bar}${' '.repeat(inner + 2)}${bar}\n`);
    for (const line of lines) process.stdout.write(`${bar}  ${pad(line, inner)}${bar}\n`);
    process.stdout.write(`${bar}${' '.repeat(inner + 2)}${bar}\n`);
    process.stdout.write(`${c.muted(`${S.railTee}${S.hline.repeat(inner + 2)}${S.cornerBR}`)}\n`);
    lastGap = false;
    out();
}

/** Aligned `key  value` rows under an optional title. */
export function keyValue(entries: Record<string, string | undefined>, title?: string): void {
    const rows = Object.entries(entries).filter((entry): entry is [string, string] => entry[1] !== undefined);
    if (rows.length === 0) return;
    const width = Math.max(...rows.map(([key]) => key.length));
    if (title) {
        if (railOpen) mark(c.success(S.stepDone), c.bold(title));
        else out(c.bold(title));
    }
    for (const [key, value] of rows) out(`${railOpen ? '' : '  '}${c.muted(key.padEnd(width))}  ${value}`);
    out();
}

/** A table, aligned by the widest cell in each column. */
export function table(headers: string[], rows: string[][], title?: string): void {
    if (title) {
        if (railOpen) mark(c.success(S.stepDone), c.bold(title));
        else out(c.bold(title));
    }
    if (rows.length === 0) return;
    const widths = headers.map((header, index) =>
        Math.max(c.strip(header).length, ...rows.map((row) => c.strip(row[index] ?? '').length)));
    const render = (cells: string[]) => cells.map((cell, index) => pad(cell ?? '', widths[index]!)).join('   ').trimEnd();
    const lead = railOpen ? '' : '  ';
    out(`${lead}${render(headers.map((header) => c.muted(header)))}`);
    out(`${lead}${c.muted(S.hline.repeat(Math.min(columns() - 8, c.strip(render(headers)).length)))}`);
    for (const row of rows) out(`${lead}${render(row)}`);
    out();
}

/** What to run next: a copyable command and the reason, aligned. */
export function nextSteps(hints: Hint[], label = 'Next'): void {
    if (hints.length === 0) return;
    const width = Math.max(...hints.map(([command]) => command.length));
    if (railOpen) mark(c.info(S.stepInfo), c.bold(label));
    else out(c.bold(label));
    for (const [command, why] of hints) out(`${railOpen ? '' : '  '}${c.info(command.padEnd(width))}  ${c.muted(why ?? '')}`);
    if (railOpen) out();
}

/** An empty state: what is missing, then what fixes it. */
export function empty(message: string, hints: Hint[], _title?: string): void {
    if (railOpen) mark(c.warn(S.stepWarn), message);
    else out(`${c.warn(S.warn)} ${message}`);
    if (hints.length) {
        out();
        nextSteps(hints, 'Try');
    }
}

/** clack's `log`: one marked line on the rail. */
export const log = {
    info: (message: string) => (railOpen ? mark(c.info(S.stepInfo), message) : out(`${c.info(S.info)} ${message}`)),
    message: (message: string) => out(railOpen ? message : `  ${message}`),
    step: (message: string) => (railOpen ? mark(c.success(S.stepDone), c.bold(message)) : out(c.bold(message))),
    success: (message: string) => (railOpen ? mark(c.success(S.stepDone), message) : out(`${c.success(S.check)} ${message}`)),
    warn: (message: string) => (railOpen ? mark(c.warn(S.stepWarn), message) : out(`${c.warn(S.warn)} ${message}`)),
    error: (message: string) => (railOpen ? mark(c.error(S.stepError), message) : out(`${c.error(S.cross)} ${message}`)),
};

/* ── live lines: spinner, staged tasks, download bar ─────────────────────── */

/** True when the platform is genuinely interactive for both streams. */
export function isInteractive(): boolean {
    return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

const live = (): boolean => Boolean(process.stdout.isTTY) && !json.isJson();
const clearLine = (): void => { process.stdout.write('\r\u001b[2K'); };
const hideCursor = (): void => { if (live()) process.stdout.write('\u001b[?25l'); };
const showCursor = (): void => { if (live()) process.stdout.write('\u001b[?25h'); };

// a Ctrl+C while a spinner hides the cursor must not leave it hidden
process.once('exit', () => { if (process.stdout.isTTY) process.stdout.write('\u001b[?25h'); });

export interface SpinnerLike {
    start: (message?: string) => void;
    stop: (message?: string) => void;
    error: (message?: string) => void;
    message: (message?: string) => void;
    /** Stops without leaving a line: the step was only a wait. */
    clear: () => void;
    /** Prints a line above the spinner without breaking its animation. */
    print: (line: string) => void;
}

/**
 * A spinner that stands where the rail's next step will be. On a terminal it
 * animates in place and leaves `◇ done` or `■ failed`; piped, it prints only
 * the outcome line, so logs keep the facts. After 3 s it shows a clock, so a
 * long wait never looks like a hang.
 */
export function spinner(): SpinnerLike {
    let text = '';
    let timer: NodeJS.Timeout | null = null;
    let frame = 0;
    let started = 0;
    const draw = () => {
        clearLine();
        const seconds = Math.floor((Date.now() - started) / 1000);
        const clock = seconds >= 3 ? c.muted(`  ${seconds}s`) : '';
        process.stdout.write(`${c.brand(S.spinner[frame % S.spinner.length]!)}  ${text}${clock}`);
        frame++;
    };
    const halt = () => {
        if (timer) clearInterval(timer);
        timer = null;
        if (live()) clearLine();
        showCursor();
    };
    return {
        start(message = '') {
            text = message;
            started = Date.now();
            if (!live()) return;
            hideCursor();
            draw();
            timer = setInterval(draw, 100);
        },
        message(message = '') {
            text = message;
        },
        clear() {
            halt();
        },
        print(line: string) {
            if (live() && timer) clearLine();
            write(`${line}\n`);
            if (live() && timer) draw();
        },
        stop(message) {
            halt();
            mark(c.success(railOpen ? S.stepDone : S.check), message ?? text);
        },
        error(message) {
            halt();
            mark(c.error(railOpen ? S.stepError : S.cross), message ?? text);
        },
    };
}

/** What one task in a staged flow looks like. */
export interface TaskStep {
    title: string;
    task: () => Promise<string | void> | string | void;
}

/**
 * Staged tasks, step by step: each spins with its number (`2/3`), then leaves
 * its result and how long it took, so the whole flow reads as a checklist.
 */
export async function tasks(flow: TaskStep[], numbering: { from?: number; total?: number } = {}): Promise<void> {
    const total = numbering.total ?? flow.length;
    const from = numbering.from ?? 1;
    for (const [index, step] of flow.entries()) {
        const counter = total > 1 ? c.muted(`${from + index}/${total}  `) : '';
        const sp = spinner();
        const began = Date.now();
        sp.start(`${counter}${step.title}`);
        try {
            const result = await step.task();
            const took = Date.now() - began;
            const said = typeof result === 'string' && result ? result : step.title;
            sp.stop(`${counter}${said}${took >= 400 ? c.muted(`  ${duration(took)}`) : ''}`);
        } catch (cause) {
            sp.error(`${counter}${step.title}`);
            throw cause;
        }
    }
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * A download with a progress bar on one line, speed included:
 * `◒  Downloading powernukkitx.jar  ████████░░░░  64%  57.3 MB · 12.1 MB/s`.
 * Resolves `true`, or the error message - the caller words the failure.
 */
export async function downloadBar(
    title: string,
    work: (update: (progress: { received: number; total: number | null; percent: number | null }) => void) => Promise<void>,
): Promise<true | string> {
    let received = 0;
    let lastDraw = 0;
    let frame = 0;
    const began = Date.now();
    const width = 24;
    const speed = () => {
        const seconds = (Date.now() - began) / 1000;
        return seconds > 0.5 ? `${(received / 1024 / 1024 / seconds).toFixed(1)} MB/s` : '';
    };
    const draw = (percent: number | null) => {
        const now = Date.now();
        if (now - lastDraw < 80 && percent !== 100) return;
        lastDraw = now;
        frame++;
        clearLine();
        const spin = c.brand(S.spinner[frame % S.spinner.length]!);
        const rate = speed() ? c.muted(` ${S.bullet} ${speed()}`) : '';
        if (percent === null) {
            process.stdout.write(`${spin}  ${title}  ${c.muted(mb(received))}${rate}`);
            return;
        }
        const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
        const bar = c.brand(S.barFull.repeat(filled)) + c.muted(S.barEmpty.repeat(width - filled));
        process.stdout.write(`${spin}  ${title}  ${bar} ${c.bold(`${String(Math.floor(percent)).padStart(3)}%`)}  ${c.muted(mb(received))}${rate}`);
    };
    try {
        hideCursor();
        await work((progress) => {
            received = progress.received;
            if (live()) draw(progress.percent);
        });
        if (live()) clearLine();
        showCursor();
        const took = duration(Date.now() - began);
        mark(c.success(railOpen ? S.stepDone : S.check), `${title}${received ? c.muted(`  ${mb(received)} in ${took}`) : ''}`);
        return true;
    } catch (cause) {
        if (live()) clearLine();
        showCursor();
        mark(c.error(railOpen ? S.stepError : S.cross), title);
        return cause instanceof Error ? cause.message : String(cause);
    }
}

/** Ends a run after the user cancelled a prompt: not a failure, exit 0. */
export function sayCancelled(message = 'Cancelled.'): never {
    if (railOpen) {
        write(`${c.muted(S.rail)}\n${c.muted(S.railEnd)}  ${c.muted(message)}\n\n`);
        railOpen = false;
    } else {
        write(`${c.muted(message)}\n`);
    }
    process.exit(0);
}
