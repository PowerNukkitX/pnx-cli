import { emitKeypressEvents } from 'node:readline';
import { c, S } from './theme.js';

/**
 * The interactive prompts: select, multi-select, text and confirm.
 *
 * Written here rather than borrowed because a prompt has one job the
 * libraries kept failing at in real terminals: draw itself once, in place.
 * An IDE terminal reports a tiny height at start-up and then resizes; a
 * prompt that redraws on resize without erasing what it drew first leaves
 * two menus on screen. So every frame here obeys three rules:
 *
 *  1. no line is ever wider than the terminal (it is cut, never wrapped),
 *     so the number of rows a frame takes is exactly its number of lines;
 *  2. a frame is never taller than the terminal, so the cursor can always
 *     climb back to its first line;
 *  3. erasing climbs by the rows the previous frame takes *now* - after a
 *     resize, a line that fitted may wrap - and clears everything below.
 *
 * Cancelling (Esc, Ctrl+C) rejects with a CancelledError the callers know.
 */

export class CancelledError extends Error {
    constructor() {
        super('cancelled');
        this.name = 'CancelledError';
    }
}

interface Key {
    name?: string;
    sequence?: string;
    ctrl?: boolean;
    meta?: boolean;
    shift?: boolean;
}

const ESC = '\u001b[';
const visible = (text: string) => c.strip(text).length;
const columns = () => Math.max(20, process.stdout.columns || 80);
const rows = () => Math.max(8, process.stdout.rows || 24);

/** Cuts a line that may hold colour codes to `width` visible characters. */
function fit(line: string, width: number): string {
    if (visible(line) <= width) return line;
    let out = '';
    let seen = 0;
    for (let i = 0; i < line.length; i++) {
        if (line[i] === '\u001b') {
            const end = line.indexOf('m', i);
            if (end > 0) { out += line.slice(i, end + 1); i = end; continue; }
        }
        if (seen >= width - 1) break;
        out += line[i];
        seen++;
    }
    return `${out}${ESC}0m${c.muted('…')}`;
}

/**
 * One live region of the terminal. `draw` replaces whatever it drew last;
 * `close` leaves a final line (or nothing) in its place.
 */
function region() {
    let drawn: string[] = [];
    const erase = () => {
        if (drawn.length === 0) return;
        const width = columns();
        const height = drawn.reduce((sum, line) => sum + Math.max(1, Math.ceil(visible(line) / width)), 0);
        process.stdout.write(`\r${height > 1 ? `${ESC}${height - 1}A` : ''}${ESC}J`);
        drawn = [];
    };
    return {
        draw(lines: string[]) {
            erase();
            const width = columns() - 1;
            drawn = lines.map((line) => fit(line, width));
            process.stdout.write(drawn.join('\n'));
        },
        /** Forget the old frame and start from the top of a cleared screen. */
        restart() {
            process.stdout.write(`${ESC}2J${ESC}H`);
            drawn = [];
        },
        close(final?: string) {
            erase();
            if (final) process.stdout.write(`${final.split('\n').map((line) => fit(line, columns() - 1)).join('\n')}\n`);
        },
    };
}

/**
 * Runs one prompt: raw keys in, frames out, a value or a cancel at the end.
 * Resizes are coalesced and simply redraw - the region erases correctly.
 */
function session<T>(
    render: () => string[],
    onKey: (input: string, key: Key, done: (value: T, summary?: string) => void, cancel: () => void) => void,
    summaryOnCancel: string,
    fullscreen = false,
): Promise<T> {
    return new Promise<T>((resolvePrompt, rejectPrompt) => {
        const stdin = process.stdin;
        const area = region();
        const wasRaw = stdin.isRaw;
        let timer: NodeJS.Timeout | null = null;
        let finished = false;

        emitKeypressEvents(stdin);
        if (stdin.isTTY) stdin.setRawMode(true);
        stdin.resume();
        process.stdout.write(`${ESC}?25l`);

        const redraw = () => { if (!finished) area.draw(render()); };
        const onResize = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                if (fullscreen && !finished) area.restart();
                redraw();
            }, 40);
        };
        const cleanup = () => {
            finished = true;
            if (timer) clearTimeout(timer);
            stdin.off('keypress', handle);
            process.stdout.off('resize', onResize);
            if (stdin.isTTY) stdin.setRawMode(Boolean(wasRaw));
            stdin.pause();
            process.stdout.write(`${ESC}?25h`);
        };
        const done = (value: T, summary?: string) => {
            area.close(summary);
            cleanup();
            resolvePrompt(value);
        };
        const cancel = () => {
            area.close(summaryOnCancel);
            cleanup();
            rejectPrompt(new CancelledError());
        };
        function handle(input: string, key: Key = {}) {
            if (key.ctrl && key.name === 'c') return cancel();
            onKey(input ?? '', key, done, cancel);
            redraw();
        }

        stdin.on('keypress', handle);
        process.stdout.on('resize', onResize);
        redraw();
    });
}

/*
 * Every prompt is drawn on the rail the commands use (see kit.ts):
 *
 *   ◆  Which PowerNukkitX version?        while it is asked
 *   │  ❯ v3.0.6   latest
 *   │    v3.0.5
 *   └  ↑↓ move · Enter choose · Esc cancel
 *
 *   ◇  Which PowerNukkitX version?        once it is answered
 *   │  v3.0.6
 */
const title = (message: string) => `${c.brand(S.stepActive)}  ${c.bold(message)}`;
const answered = (message: string, answer: string) =>
    `${c.success(S.stepDone)}  ${message}\n${c.muted(S.rail)}  ${c.muted(c.strip(answer))}`;
const cancelled = (message: string) => `${c.error(S.stepError)}  ${c.muted(message)}`;
const footer = (parts: string[]) => c.muted(parts.join(`  ${S.bullet}  `));

/** Hangs a prompt's lines on the rail: title, then `│` rows, then `└` help. */
function framed(lines: string[]): string[] {
    if (lines.length === 0) return lines;
    const [head, ...rest] = lines;
    const tail = rest.pop();
    return [
        head!,
        ...rest.map((line) => `${c.brand(S.rail)}  ${line.replace(/^ {1,2}/, '')}`),
        ...(tail !== undefined ? [`${c.brand(S.railEnd)}  ${tail}`] : []),
    ];
}

/* ── select ─────────────────────────────────────────────────────────────── */

export interface Choice<T> {
    value: T;
    label: string;
    hint?: string;
}

/** A non-selectable line inside a list: a group title, or a blank gap. */
export interface Heading {
    heading: string;
}

export type SelectItem<T> = Choice<T> | Heading;

const isHeading = <T>(item: SelectItem<T>): item is Heading => 'heading' in item;

export interface SelectOptions<T> {
    message: string;
    options: Array<SelectItem<T>>;
    initialValue?: T;
    /** Most rows of choices shown at once; the list scrolls past it. */
    maxItems?: number;
    /** Esc does this instead of cancelling (e.g. "back" in a sub-menu). */
    escapeValue?: T;
    /** Keys that pick a choice directly: `{ q: 'quit' }`. */
    shortcuts?: Record<string, T>;
    /** What Esc does, as shown in the help line ("back", "quit"). */
    escapeLabel?: string;
    /** Lines drawn above the question, as part of the same frame. */
    preamble?: string[];
    /** The prompt owns the screen: a resize clears it and draws again. */
    fullscreen?: boolean;
}

/**
 * Pick one. Arrows (or j/k) move, Enter picks, digits 1-9 pick the n-th
 * choice. Long lists get a filter: typing narrows them, Backspace widens.
 */
export function select<T>(opts: SelectOptions<T>): Promise<T> {
    const all = opts.options;
    const choices = all.filter((item): item is Choice<T> => !isHeading(item));
    const filterable = choices.length > 9;
    const numbered = !filterable && choices.length > 1;
    let query = '';
    let cursor = Math.max(0, choices.findIndex((choice) => choice.value === opts.initialValue));
    let top = 0;

    const matches = () => {
        if (!query) return all;
        const needle = query.toLowerCase();
        return all.filter((item) => !isHeading(item)
            && `${item.label} ${item.hint ?? ''}`.toLowerCase().includes(needle));
    };
    const selectable = () => matches().filter((item): item is Choice<T> => !isHeading(item));

    const render = () => {
        const shown = matches();
        const pickable = selectable();
        if (cursor >= pickable.length) cursor = Math.max(0, pickable.length - 1);
        const current = pickable[cursor];
        const labelWidth = Math.min(32, Math.max(0, ...pickable.map((choice) => choice.label.length)));
        const window = Math.max(3, Math.min(opts.maxItems ?? 12, rows() - 6 - (opts.preamble?.length ?? 0)));

        // keep the cursor's line inside the window, headings included
        const at = shown.findIndex((item) => item === current);
        if (at < top) top = at;
        if (at >= top + window) top = at - window + 1;
        // a group title travels with the first choice under it
        if (top === at && at > 0 && isHeading(shown[at - 1]!)) top = at - 1;
        if (at < window) top = 0;
        top = Math.max(0, Math.min(top, shown.length - window));

        const lines = [...(opts.preamble ?? []), title(opts.message)];
        if (filterable) {
            lines.push(query
                ? `  ${c.muted('filter:')} ${query}${c.inverse(' ')}`
                : `  ${c.muted('type to filter')}`);
        }
        if (shown.length === 0) lines.push(`  ${c.muted('nothing matches')}`);
        let number = 0;
        const numberOf = new Map<Choice<T>, number>();
        for (const item of all) if (!isHeading(item)) numberOf.set(item, ++number);
        for (const item of shown.slice(top, top + window)) {
            if (isHeading(item)) {
                lines.push(item.heading ? `  ${c.dim(c.bold(item.heading.toUpperCase()))}` : '');
                continue;
            }
            const active = item === current;
            const key = numbered ? c.muted(`${numberOf.get(item)}`) + ' ' : '';
            const label = active ? c.bold(item.label) : c.muted(item.label);
            const hint = item.hint ? `  ${c.muted(item.hint)}` : '';
            const pad = ' '.repeat(Math.max(0, labelWidth - item.label.length));
            lines.push(`${active ? c.brand(S.dot) : c.muted(S.ring)} ${key}${label}${pad}${hint}`);
        }
        if (shown.length > window) {
            lines.push(`  ${c.muted(`${top + 1}-${Math.min(shown.length, top + window)} of ${shown.length}`)}`);
        }
        const help = [`${S.up}${S.down} move`, 'Enter choose'];
        if (numbered) help.push(`1-${Math.min(9, choices.length)} jump`);
        help.push(`Esc ${opts.escapeLabel ?? 'cancel'}`);
        lines.push(footer(help));
        return [...(opts.preamble ?? []), ...framed(lines.slice(opts.preamble?.length ?? 0))];
    };

    return session<T>(render, (input, key, done, cancel) => {
        const pickable = selectable();
        const pick = (choice: Choice<T> | undefined) => {
            if (choice) done(choice.value, answered(opts.message, choice.label));
        };
        if (key.name === 'up' || (!filterable && input === 'k')) cursor = (cursor - 1 + pickable.length) % Math.max(1, pickable.length);
        else if (key.name === 'down' || (!filterable && input === 'j') || key.name === 'tab') cursor = (cursor + 1) % Math.max(1, pickable.length);
        else if (key.name === 'home') cursor = 0;
        else if (key.name === 'end') cursor = pickable.length - 1;
        else if (key.name === 'pageup') cursor = Math.max(0, cursor - 8);
        else if (key.name === 'pagedown') cursor = Math.min(pickable.length - 1, cursor + 8);
        else if (key.name === 'return' || key.name === 'enter') pick(pickable[cursor]);
        else if (key.name === 'escape') {
            if (query) { query = ''; cursor = 0; }
            else if (opts.escapeValue !== undefined) done(opts.escapeValue);
            else cancel();
        } else if (filterable && key.name === 'backspace') { query = query.slice(0, -1); cursor = 0; }
        else if (numbered && /^[1-9]$/.test(input)) pick(choices[Number(input) - 1]);
        else if (!filterable && opts.shortcuts && input && opts.shortcuts[input.toLowerCase()] !== undefined) {
            done(opts.shortcuts[input.toLowerCase()]!);
        } else if (filterable && input && !key.ctrl && !key.meta && input >= ' ' && input.length === 1) {
            query += input;
            cursor = 0;
        }
    }, cancelled(opts.message), opts.fullscreen);
}

/* ── multi-select ───────────────────────────────────────────────────────── */

export interface MultiOptions<T> {
    message: string;
    options: Array<Choice<T>>;
    initialValues?: T[];
    maxItems?: number;
}

/** Pick several. Space toggles, `a` toggles all, Enter confirms. */
export function multiselect<T>(opts: MultiOptions<T>): Promise<T[]> {
    const picked = new Set<T>(opts.initialValues ?? []);
    const filterable = opts.options.length > 9;
    let query = '';
    let cursor = 0;
    let top = 0;

    const shown = () => {
        if (!query) return opts.options;
        const needle = query.toLowerCase();
        return opts.options.filter((choice) => `${choice.label} ${choice.hint ?? ''}`.toLowerCase().includes(needle));
    };

    const render = () => {
        const list = shown();
        if (cursor >= list.length) cursor = Math.max(0, list.length - 1);
        const window = Math.max(3, Math.min(opts.maxItems ?? 10, rows() - 7));
        if (cursor < top) top = cursor;
        if (cursor >= top + window) top = cursor - window + 1;
        const labelWidth = Math.min(28, Math.max(0, ...list.map((choice) => choice.label.length)));
        const lines = [`${title(opts.message)} ${c.muted(`${picked.size} selected`)}`];
        if (filterable) {
            lines.push(query ? `  ${c.muted('filter:')} ${query}${c.inverse(' ')}` : `  ${c.muted('type to filter')}`);
        }
        if (list.length === 0) lines.push(`  ${c.muted('nothing matches')}`);
        list.slice(top, top + window).forEach((choice, index) => {
            const active = top + index === cursor;
            const on = picked.has(choice.value);
            const box = on ? c.success(S.boxOn) : c.muted(S.boxOff);
            const label = active ? c.bold(c.info(choice.label)) : choice.label;
            const pad = ' '.repeat(Math.max(0, labelWidth - choice.label.length));
            lines.push(`${active ? c.brand(S.pointer) : ' '} ${box} ${label}${pad}${choice.hint ? `  ${c.muted(choice.hint)}` : ''}`);
        });
        if (list.length > window) {
            lines.push(`  ${c.muted(`${top + 1}-${Math.min(list.length, top + window)} of ${list.length}`)}`);
        }
        lines.push(footer([`${S.up}${S.down} move`, 'Space pick', filterable ? 'Ctrl+A all' : 'a all', 'Enter confirm', 'Esc cancel']));
        return framed(lines);
    };

    return session<T[]>(render, (input, key, done, cancel) => {
        const list = shown();
        if (key.name === 'up') cursor = (cursor - 1 + list.length) % Math.max(1, list.length);
        else if (key.name === 'down' || key.name === 'tab') cursor = (cursor + 1) % Math.max(1, list.length);
        else if (key.name === 'home') cursor = 0;
        else if (key.name === 'end') cursor = list.length - 1;
        else if (key.name === 'pageup') cursor = Math.max(0, cursor - 8);
        else if (key.name === 'pagedown') cursor = Math.min(list.length - 1, cursor + 8);
        else if (key.name === 'space') {
            const choice = list[cursor];
            if (choice) {
                if (picked.has(choice.value)) picked.delete(choice.value);
                else picked.add(choice.value);
            }
        } else if ((key.ctrl && key.name === 'a') || (!filterable && input === 'a')) {
            const everyOn = list.every((choice) => picked.has(choice.value));
            for (const choice of list) {
                if (everyOn) picked.delete(choice.value);
                else picked.add(choice.value);
            }
        } else if (key.name === 'return' || key.name === 'enter') {
            const values = opts.options.filter((choice) => picked.has(choice.value));
            done(values.map((choice) => choice.value), answered(opts.message,
                values.length === 0 ? 'none' : values.map((choice) => choice.label).join(', ')));
        } else if (key.name === 'escape') {
            if (query) { query = ''; cursor = 0; } else cancel();
        } else if (filterable && key.name === 'backspace') { query = query.slice(0, -1); cursor = 0; }
        else if (filterable && input && !key.ctrl && !key.meta && input > ' ' && input.length === 1) {
            query += input;
            cursor = 0;
        }
    }, cancelled(opts.message));
}

/* ── text ───────────────────────────────────────────────────────────────── */

export interface TextOptions {
    message: string;
    placeholder?: string;
    /** Used when Enter is pressed on an empty line. */
    defaultValue?: string;
    initialValue?: string;
    /** Returns an error message to show, or nothing when the value is fine. */
    validate?: (value: string) => string | undefined | void;
}

/** One line of text, with the usual editing keys. */
export function text(opts: TextOptions): Promise<string> {
    let value = opts.initialValue ?? '';
    let at = value.length;
    let error = '';

    const render = () => {
        const before = value.slice(0, at);
        const under = value[at] ?? ' ';
        const after = value.slice(at + 1);
        const field = value.length === 0 && opts.placeholder
            ? `${c.inverse(opts.placeholder[0] ?? ' ')}${c.muted(opts.placeholder.slice(1))}`
            : `${before}${c.inverse(under)}${after}`;
        const lines = [title(opts.message), `  ${c.info(S.pointer)} ${field}`];
        if (error) lines.push(`  ${c.error(error)}`);
        lines.push(footer(opts.defaultValue && !value
            ? [`Enter keeps "${opts.defaultValue}"`, 'Esc cancel']
            : ['Enter confirm', 'Esc cancel']));
        return framed(lines);
    };

    return session<string>(render, (input, key, done, cancel) => {
        if (key.name === 'return' || key.name === 'enter') {
            const final = value.trim() === '' && opts.defaultValue !== undefined ? opts.defaultValue : value;
            const problem = opts.validate?.(final);
            if (problem) { error = problem; return; }
            done(final, answered(opts.message, final || c.muted('(empty)')));
            return;
        }
        error = '';
        if (key.name === 'escape') cancel();
        else if (key.name === 'backspace') {
            if (at > 0) { value = value.slice(0, at - 1) + value.slice(at); at--; }
        } else if (key.name === 'delete') value = value.slice(0, at) + value.slice(at + 1);
        else if (key.name === 'left') at = Math.max(0, at - 1);
        else if (key.name === 'right') at = Math.min(value.length, at + 1);
        else if (key.name === 'home' || (key.ctrl && key.name === 'a')) at = 0;
        else if (key.name === 'end' || (key.ctrl && key.name === 'e')) at = value.length;
        else if (key.ctrl && key.name === 'u') { value = value.slice(at); at = 0; }
        else if (input && !key.ctrl && !key.meta) {
            const typed = input.replace(/[\r\n\u0000-\u001f]/g, '');
            value = value.slice(0, at) + typed + value.slice(at);
            at += typed.length;
        }
    }, cancelled(opts.message));
}

/* ── confirm ────────────────────────────────────────────────────────────── */

/** Yes or no: y/n answer at once, arrows switch, Enter takes the highlighted one. */
export function confirm(message: string, initialValue = false): Promise<boolean> {
    let yes = initialValue;
    const render = () => {
        const option = (label: string, on: boolean) => (on ? `${c.brand(S.dot)} ${c.bold(label)}` : `${c.muted(S.ring)} ${c.muted(label)}`);
        return framed([
            title(message),
            `  ${option('Yes', yes)} ${c.muted('/')} ${option('No', !yes)}`,
            footer(['y / n', `${S.left}${S.right} switch`, 'Enter confirm', 'Esc cancel']),
        ]);
    };
    return session<boolean>(render, (input, key, done, cancel) => {
        const answer = (value: boolean) => done(value, answered(message, value ? 'Yes' : 'No'));
        if (input.toLowerCase() === 'y') answer(true);
        else if (input.toLowerCase() === 'n') answer(false);
        else if (['left', 'right', 'tab', 'up', 'down'].includes(key.name ?? '')) yes = !yes;
        else if (key.name === 'return' || key.name === 'enter') answer(yes);
        else if (key.name === 'escape') cancel();
    }, cancelled(message));
}

/** Waits for Enter (or Esc), to keep a result on screen before a menu returns. */
export function pressEnter(message = 'Enter  back to the menu'): Promise<void> {
    return session<void>(
        () => [c.muted(`  ${message}`)],
        (_input, key, done) => {
            if (['return', 'enter', 'escape', 'space'].includes(key.name ?? '')) done(undefined);
        },
        '',
    ).catch(() => undefined);
}
