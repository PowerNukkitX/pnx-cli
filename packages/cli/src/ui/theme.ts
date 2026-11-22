import { release } from 'node:os';

/**
 * The design language, in one palette.
 *
 * PowerNukkitX's site (powernukkitx.org) reads as near-black surfaces lit by
 * one grass-green accent - `oklch(0.76 0.21 148)`, the site's default
 * `data-accent=grass`, exactly #25d35c - with gold (#d59800) as the warning
 * tone and red (#d81327) reserved for what is broken. LaunchUI contributes the
 * structure: thin rails, soft corners, generous space between blocks, and one
 * accent doing the pointing. Everything below is those rules as ANSI - including
 * the one gradient, spent on the brand name and the rules that frame a card, so
 * it never competes with a status colour for attention.
 */

export const BRAND = {
    /** The site's grass accent, oklch(.76 .21 148). */
    green: [0x25, 0xd3, 0x5c],
    /** The deep end of the gradient, where the accent lands when it fades. */
    deep: [0x00, 0xaf, 0x37],
    /** The site's exact warning gold. */
    gold: [0xd5, 0x98, 0x00],
    /** The site's exact destructive red. */
    red: [0xd8, 0x13, 0x27],
};

let colorOn = true;

/**
 * Switches colour off (or back on) for the rest of the run. Every colour in
 * this file goes through `paint`, so this one switch is the whole truth: no
 * library deciding behind it from its own reading of the environment (the
 * picocolors flags this used to flip were never read, so pipes got ANSI).
 */
export function setColorEnabled(enabled: boolean): void {
    colorOn = enabled;
}

/** Whether colour is on right now. */
export function colorEnabled(): boolean {
    return colorOn;
}

function paint(text: string, code: string, close = '0'): string {
    return colorOn ? `\u001b[${code}m${text}\u001b[${close}m` : text;
}

/** Interpolates two RGB colours, t from 0 (from) to 1 (to). */
function mix(from: readonly number[], to: readonly number[], t: number): readonly number[] {
    const [r1 = 0, g1 = 0, b1 = 0] = from;
    const [r2 = 0, g2 = 0, b2 = 0] = to;
    return [
        Math.round(r1 + (r2 - r1) * t),
        Math.round(g1 + (g2 - g1) * t),
        Math.round(b1 + (b2 - b1) * t),
    ];
}

/**
 * Paints each character along the grass-to-deep green gradient.
 *
 * Applied per character, since ANSI has no gradient primitive and a prefix-only
 * colour would fade nothing.
 */
export function gradient(text: string): string {
    if (!colorOn) return text;
    const chars = [...text];
    return chars
        .map((char, index) => {
            if (char === '\n') return char;
            const [r, g, b] = mix(
                BRAND.green,
                BRAND.deep,
                chars.length > 1 ? index / (chars.length - 1) : 0,
            );
            return `\u001b[38;2;${r};${g};${b}m${char}\u001b[0m`;
        })
        .join('');
}

/**
 * A horizontal rule that fades grass to deep green.
 *
 * The frame element this project leans on most: it opens a run, it closes one,
 * it separates the blocks of a card. One line, no content, all signal.
 */
export function rule(width: number): string {
    if (!colorOn) return (unicodeSupported() ? '─' : '-').repeat(Math.max(1, width));
    let line = '';
    const glyph = unicodeSupported() ? '─' : '-';
    for (let index = 0; index < width; index++) {
        const [r, g, b] = mix(BRAND.green, BRAND.deep, index / Math.max(1, width - 1));
        line += `\u001b[38;2;${r};${g};${b}m${glyph}\u001b[0m`;
    }
    return line;
}

/** The palette itself. One accent (`brand`), four states, two kinds of quiet. */
export const c = {
    red: (text: string) => paint(text, '31', '39'),
    brand: (text: string) => paint(text, '38;2;37;211;92', '39'),
    gold: (text: string) => paint(text, '38;2;213;152;0', '39'),
    success: (text: string) => paint(text, '32', '39'),
    warn: (text: string) => paint(text, '33', '39'),
    error: (text: string) => paint(text, '31', '39'),
    info: (text: string) => paint(text, '36', '39'),
    muted: (text: string) => paint(text, '90', '39'),
    bold: (text: string) => paint(text, '1', '22'),
    dim: (text: string) => paint(text, '2', '22'),
    inverse: (text: string) => paint(text, '7', '27'),
    /** A label on the brand colour, ` pnx ` as create-astro's ` astro `. */
    badge: (text: string) => (colorOn ? `\u001b[48;2;37;211;92m\u001b[38;2;10;10;10m\u001b[1m ${text} \u001b[22m\u001b[39m\u001b[49m` : `[${text}]`),
    gradient,
    rule,
    strip: (text: string) => String(text).replace(/\u001b\[[0-9;]*m/g, ''),
};

/**
 * Whether this terminal draws Unicode. Modern terminals do; the old Windows
 * console host does not, and a box of question marks reads as a crash.
 */
export function unicodeSupported(): boolean {
    if (process.env.PNX_ASCII) return false;
    if (process.platform !== 'win32') return process.env.TERM !== 'linux';
    return Boolean(
        process.env.WT_SESSION // Windows Terminal
        || process.env.TERMINUS_SUBLIME
        || process.env.ConEmuTask === '{cmd::Cmder}'
        || process.env.TERM_PROGRAM === 'vscode'
        || process.env.TERM === 'xterm-256color'
        || process.env.TERM === 'alacritty'
        || process.env.TERMINAL_EMULATOR === 'JetBrains-JediTerm'
        || Boolean(process.env.IDEA_INITIAL_DIRECTORY) // JetBrains IDEs
        || process.env.TERM_PROGRAM === 'WezTerm'
        // Windows 11 (build 22000+): Windows Terminal is the default host, and
        // even the classic console draws box and geometric glyphs
        || Number(release().split('.')[2] ?? 0) >= 22000,
    );
}

const UNICODE = unicodeSupported();

/** The glyphs this project uses, with a plain-ASCII twin for old consoles. */
export const S = {
    bar: UNICODE ? '│' : '|',
    dash: UNICODE ? '─' : '-',
    dot: UNICODE ? '●' : '*',
    ring: UNICODE ? '○' : 'o',
    arrow: UNICODE ? '→' : '->',
    bullet: UNICODE ? '·' : '-',
    check: UNICODE ? '✓' : '√',
    pointer: UNICODE ? '❯' : '>',
    up: UNICODE ? '↑' : '^',
    down: UNICODE ? '↓' : 'v',
    left: UNICODE ? '←' : '<',
    right: UNICODE ? '→' : '>',
    boxOn: UNICODE ? '◼' : '[x]',
    boxOff: UNICODE ? '◻' : '[ ]',
    cross: UNICODE ? '✗' : 'x',
    warn: UNICODE ? '!' : '!',
    info: UNICODE ? '›' : '>',
    cornerTL: UNICODE ? '╭' : '+',
    cornerTR: UNICODE ? '╮' : '+',
    cornerBR: UNICODE ? '╯' : '+',
    cornerBL: UNICODE ? '╰' : '+',
    sparkle: UNICODE ? '✦' : '*',
    /** The brand mark, as `▲` is Next's: the diamond of the site's logo. */
    logo: UNICODE ? '◆' : '*',
    ellipsis: UNICODE ? '…' : '...',
    /** clack's quarter-circle spinner: geometric shapes every console font has */
    spinner: UNICODE ? ['◒', '◐', '◓', '◑'] : ['|', '/', '-', '\\'],
    /* the rail that threads a run, top to bottom, as clack / create-astro draw it */
    railTop: UNICODE ? '┌' : '+',
    rail: UNICODE ? '│' : '|',
    railEnd: UNICODE ? '└' : '+',
    railTee: UNICODE ? '├' : '+',
    stepDone: UNICODE ? '◇' : 'o',
    stepActive: UNICODE ? '◆' : '*',
    stepError: UNICODE ? '■' : 'x',
    stepWarn: UNICODE ? '▲' : '!',
    stepInfo: UNICODE ? '●' : '*',
    hline: UNICODE ? '─' : '-',
    barFull: UNICODE ? '█' : '#',
    barEmpty: UNICODE ? '░' : '.',
} as const;


