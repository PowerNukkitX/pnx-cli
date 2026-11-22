import { c, gradient, S, unicodeSupported } from './theme.js';

/**
 * The pieces of the menu's home screen: a logo that says which tool this is
 * from across the room, and a card that says which server it is about.
 * Pure functions of their input, so they render the same in a test.
 */

const LOGO_UNICODE = [
    '██████╗ ███╗   ██╗██╗  ██╗',
    '██╔══██╗████╗  ██║╚██╗██╔╝',
    '██████╔╝██╔██╗ ██║ ╚███╔╝ ',
    '██╔═══╝ ██║╚██╗██║ ██╔██╗ ',
    '██║     ██║ ╚████║██╔╝ ██╗',
    '╚═╝     ╚═╝  ╚═══╝╚═╝  ╚═╝',
];

const LOGO_ASCII = [
    ' ____  _   ___  __',
    '|  _ \\| \\ | \\ \\/ /',
    '| |_) |  \\| |\\  / ',
    '|  __/| |\\  |/  \\ ',
    '|_|   |_| \\_/_/\\_\\',
    '                  ',
];

const visible = (text: string): number => c.strip(text).length;
const padTo = (text: string, width: number): string => text + ' '.repeat(Math.max(0, width - visible(text)));

/** The block logo in the brand gradient, with `side` lines printed beside it. */
export function logo(side: string[]): string[] {
    const art = unicodeSupported() ? LOGO_UNICODE : LOGO_ASCII;
    return art.map((row, index) => `  ${gradient(row)}   ${side[index] ?? ''}`.trimEnd());
}

/** Cuts a plain-or-coloured string to a visible width, with an ellipsis. */
export function clip(text: string, width: number): string {
    if (visible(text) <= width) return text;
    const plain = c.strip(text);
    return `${plain.slice(0, Math.max(0, width - 1))}${S.ellipsis}`;
}

/**
 * A rounded card with a title on its top edge and a status on the right:
 *
 *   ╭─ my-server ─────────────────── ● online ─╮
 *   │  PowerNukkitX 3.0.6 · 3 plugins           │
 *   ╰───────────────────────────────────────────╯
 */
export function card(title: string, status: string, body: string[], width: number): string[] {
    const h = S.hline;
    const inner = Math.max(20, width - 2);
    const head = ` ${title} `;
    const tail = status ? ` ${status} ` : '';
    const fill = Math.max(1, inner - 1 - visible(head) - visible(tail) - 1);
    const top = `${c.muted(`${S.cornerTL}${h}`)}${c.bold(head)}${c.muted(h.repeat(fill))}${tail}${c.muted(`${h}${S.cornerTR}`)}`;
    const rows = body.map((line) => `${c.muted(S.rail)}  ${padTo(clip(line, inner - 4), inner - 3)} ${c.muted(S.rail)}`);
    const bottom = c.muted(`${S.cornerBL}${h.repeat(inner)}${S.cornerBR}`);
    return [top, ...rows, bottom].map((line) => `  ${line}`);
}

/** `● online` / `○ offline`, the only coloured word on the card. */
export function pill(online: boolean, label?: string): string {
    return online ? c.success(`${S.dot} ${label ?? 'online'}`) : c.muted(`${S.ring} ${label ?? 'offline'}`);
}
