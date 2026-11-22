import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Reading and changing one value in the server's configuration, without
 * touching anything else in the file.
 *
 * `pnx.yml` is hand-edited and full of comments, so it is never parsed into an
 * object and dumped back: a key is found by walking the lines with their
 * indentation, and a write replaces only the value on that one line. Lists,
 * blocks and multi-line values are out of reach on purpose - they belong in an
 * editor, not on a command line.
 */

export interface ConfigFile {
    path: string;
    kind: 'yml' | 'properties';
    text: string;
}

/** `pnx.yml` first, the old `server.properties` second, or null. */
export function openConfig(serverDir: string): ConfigFile | null {
    for (const [name, kind] of [['pnx.yml', 'yml'], ['server.properties', 'properties']] as const) {
        const path = join(serverDir, name);
        if (!existsSync(path)) continue;
        let text = readFileSync(path, 'utf-8');
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        return { path, kind, text };
    }
    return null;
}

export interface Leaf {
    /** dotted path, e.g. `settings.port` */
    key: string;
    value: string;
    /** line index in the file */
    line: number;
}

const unquote = (value: string): string => {
    const trimmed = value.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
};

/** Strips a trailing ` # comment` that is not inside quotes. */
function stripComment(value: string): string {
    let quote: string | null = null;
    for (let index = 0; index < value.length; index++) {
        const char = value[index]!;
        if (quote) {
            if (char === quote) quote = null;
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === '#' && (index === 0 || /\s/.test(value[index - 1]!))) {
            return value.slice(0, index).trimEnd();
        }
    }
    return value;
}

/** Every scalar leaf in the file, in file order. */
export function leaves(file: ConfigFile): Leaf[] {
    const lines = file.text.split(/\r?\n/);
    const found: Leaf[] = [];

    if (file.kind === 'properties') {
        lines.forEach((raw, line) => {
            const trimmed = raw.trim();
            if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) return;
            const at = trimmed.indexOf('=');
            if (at <= 0) return;
            found.push({ key: trimmed.slice(0, at).trim(), value: trimmed.slice(at + 1).trim(), line });
        });
        return found;
    }

    const stack: Array<{ indent: number; key: string }> = [];
    lines.forEach((raw, line) => {
        if (!raw.trim() || raw.trim().startsWith('#') || raw.trim().startsWith('-')) return;
        const match = raw.match(/^(\s*)([^:#\s][^:#]*?)\s*:(?:\s+(.*))?$/);
        if (!match) return;
        const indent = match[1]!.length;
        const key = match[2]!.trim();
        while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
        const value = stripComment(match[3] ?? '').trim();
        const path = [...stack.map((entry) => entry.key), key].join('.');
        if (value === '' || value === '|' || value === '>') {
            stack.push({ indent, key });
            return;
        }
        found.push({ key: path, value: unquote(value), line });
    });
    return found;
}

/** One leaf by dotted key, case-insensitive; also matches a unique last segment (`port`). */
export function findLeaf(file: ConfigFile, key: string): Leaf | Leaf[] | null {
    const all = leaves(file);
    const lower = key.toLowerCase();
    const exact = all.find((leaf) => leaf.key.toLowerCase() === lower);
    if (exact) return exact;
    const bySuffix = all.filter((leaf) => leaf.key.toLowerCase().endsWith(`.${lower}`));
    if (bySuffix.length === 1) return bySuffix[0]!;
    return bySuffix.length > 1 ? bySuffix : null;
}

/** Quotes a YAML value only when a bare one would change meaning. */
function yamlValue(value: string, previous: string): string {
    const raw = previous.trim();
    if (raw.startsWith('"')) return `"${value.replace(/["\\]/g, '\\$&')}"`;
    if (raw.startsWith("'")) return `'${value.replace(/'/g, "''")}'`;
    if (value === '' || /^[\s]|[\s]$|[:#{}[\],&*!|>'"%@`]/.test(value)) return `"${value.replace(/["\\]/g, '\\$&')}"`;
    return value;
}

/** Rewrites one leaf's value in place; returns the previous value. */
export function setLeaf(file: ConfigFile, leaf: Leaf, value: string): string {
    const lines = file.text.split(/(?<=\n)/);
    const raw = lines[leaf.line]!;
    const eol = raw.match(/\r?\n$/)?.[0] ?? '';
    const body = raw.slice(0, raw.length - eol.length);
    let next: string;
    if (file.kind === 'properties') {
        const at = body.indexOf('=');
        next = `${body.slice(0, at + 1)}${value}`;
    } else {
        const colon = body.indexOf(':');
        const after = body.slice(colon + 1);
        const lead = after.match(/^\s*/)?.[0] || ' ';
        const valuePart = after.slice(lead.length);
        const kept = stripComment(valuePart);
        const comment = valuePart.slice(kept.length);
        next = `${body.slice(0, colon + 1)}${lead}${yamlValue(value, kept)}${comment}`;
    }
    lines[leaf.line] = `${next}${eol}`;
    writeFileSync(file.path, lines.join(''), 'utf-8');
    file.text = lines.join('');
    return leaf.value;
}

/** The UDP port the server listens on, as its config says (19132 otherwise). */
export function serverPort(serverDir: string | null): number {
    if (!serverDir) return 19132;
    const file = openConfig(serverDir);
    if (!file) return 19132;
    const leaf = findLeaf(file, file.kind === 'yml' ? 'settings.port' : 'server-port');
    const port = leaf && !Array.isArray(leaf) ? Number.parseInt(leaf.value, 10) : Number.NaN;
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : 19132;
}
