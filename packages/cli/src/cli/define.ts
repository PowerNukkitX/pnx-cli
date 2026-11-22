/**
 * The parser, and the shape every command receives.
 *
 * Hand-rolled on purpose. The old tool went through a framework for argument
 * parsing and then spent a hundred lines papering over its error screens: usage
 * dumps burying the actual message, unknown commands described as unknown, and
 * stack traces for a missing argument. What a CLI needs here is small - value
 * and boolean flags, short forms, and honest errors - so the parser and its one
 * error type live in the same file, with no framework between this tool and its
 * own behaviour.
 */

/** One option a command accepts. */
export interface OptionSpec {
    /** Long name, without the leading `--`. */
    name: string;
    /** One-letter form, without the leading `-`. */
    short?: string;
    type: 'string' | 'boolean';
    /** One sentence, shown in help. */
    desc?: string;
    /** What an absent value falls back to. */
    default?: string | boolean;
    /** How the value is printed in usage, e.g. `<mb>` for `--memory`. */
    valueName?: string;
    /** The only values accepted; checked by the parser, offered by tab completion. */
    choices?: string[];
}

/** A bare word a command reads, in order. */
export interface PositionalSpec {
    name: string;
    desc?: string;
    required?: boolean;
}

export interface ParsedArgs {
    flags: Record<string, string | boolean>;
    positionals: string[];
}

export interface RunContext {
    args: ParsedArgs;
}

/** Everything a user can ask for, in words. */
export class CliError extends Error {
    readonly hint?: string;

    constructor(message: string, hint?: string) {
        super(message);
        this.name = 'CliError';
        this.hint = hint;
    }
}

/** What a command is. */
export interface CommandSpec {
    /** Full path spoken by the user, e.g. `plugin install`. */
    name: string;
    group: string;
    aliases?: string[];
    summary: string;
    description?: string;
    options?: OptionSpec[];
    positionals?: PositionalSpec[];
    examples?: string[];
    /** Resolvable, but left out of the help list (e.g. `plugin`, which is only a group). */
    hidden?: boolean;
    run: (ctx: RunContext) => Promise<void>;
}

interface OptionEntry {
    spec: OptionSpec;
    type: 'string' | 'boolean';
    default: string | boolean;
}

/** Builds the internal option lists once, from the spec's public shape. */
function assemble(spec: CommandSpec): { byName: Map<string, OptionEntry>; shorts: Map<string, string> } {
    const byName = new Map<string, OptionEntry>();
    const shorts = new Map<string, string>();
    for (const option of spec.options ?? []) {
        byName.set(option.name, {
            spec: option,
            type: option.type,
            default: option.default ?? (option.type === 'boolean' ? false : ''),
        });
        if (option.short) shorts.set(option.short, option.name);
    }
    return { byName, shorts };
}

/**
 * Closest known spelling, for a did-you-mean that is right far more often than
 * it is silly: a prefix wins (`pnx sta` → `start`), otherwise the edit distance
 * must be small for the word's length (`stra` → `start`, but `foo` → nothing).
 */
export function nearest(word: string, candidates: string[]): string | null {
    const lower = word.toLowerCase();
    if (lower.length >= 2) {
        const prefixed = candidates.filter((candidate) => candidate.toLowerCase().startsWith(lower));
        if (prefixed.length > 0) return prefixed.sort((a, b) => a.length - b.length)[0]!;
    }
    let best: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
        const distance = levenshtein(lower, candidate.toLowerCase());
        if (distance < bestScore) {
            bestScore = distance;
            best = candidate;
        }
    }
    const allowed = lower.length <= 4 ? 1 : 2;
    return bestScore <= allowed && bestScore < lower.length / 2 ? best : null;
}

function levenshtein(a: string, b: string): number {
    const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) rows[0]![j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            rows[i]![j] = Math.min(
                rows[i - 1]![j]! + 1,
                rows[i]![j - 1]! + 1,
                rows[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
        }
    }
    return rows[a.length]![b.length]!;
}

/**
 * Parses raw argv against a spec.
 *
 * Accepts `--flag`, `--flag value`, `--flag=value`, `-f` and `-f value`.
 * Boolean flags accept `--flag=false`, and `--no-flag` negates a declared
 * boolean: `pnx start --no-restart` is the same as absent, `--restart` turns on.
 */
export function parseArgv(argv: string[], spec: CommandSpec): ParsedArgs {
    const { byName, shorts } = assemble(spec);
    const unknown = (token: string): CliError => {
        const guess = token.startsWith('--')
            ? nearest(token.slice(2).split('=')[0] ?? '', [...byName.keys()])
            : null;
        return new CliError(
            guess ? `Unknown option ${token}. Did you mean --${guess}?` : `Unknown option ${token}`,
            `Run \`pnx ${spec.name} --help\` for the options this command takes.`,
        );
    };
    const checkChoice = (entry: OptionEntry, value: string): string => {
        const choices = entry.spec.choices;
        if (choices && !choices.includes(value)) {
            throw new CliError(
                `--${entry.spec.name} must be one of ${choices.join(', ')} (got \`${value}\`).`,
                `Example: --${entry.spec.name} ${choices[0]}`,
            );
        }
        return value;
    };
    const flags: Record<string, string | boolean> = {};
    const positionals: string[] = [];

    for (const [name, entry] of byName) {
        if (entry.type === 'boolean') flags[name] = entry.default === true;
        else if (entry.default) flags[name] = entry.default as string;
    }

    let index = 0;
    while (index < argv.length) {
        const token = argv[index] ?? '';
        if (token === '--') {
            positionals.push(...argv.slice(index + 1));
            break;
        }

        if (token.startsWith('--')) {
            const [long, inline] = token.slice(2).split(/=(.*)/, 2);
            const name = long ?? '';
            const entry = byName.get(name);
            if (!entry) {
                if (name.startsWith('no-')) {
                    const target = byName.get(name.slice(3));
                    if (target?.type === 'boolean') {
                        flags[target.spec.name] = false;
                        index++;
                        continue;
                    }
                }
                throw unknown(token);
            }
            if (entry.type === 'boolean') {
                flags[entry.spec.name] = inline === undefined ? true : inline !== 'false';
            } else {
                if (inline !== undefined) {
                    flags[entry.spec.name] = checkChoice(entry, inline);
                    index++;
                    continue;
                }
                const next = argv[index + 1];
                if (next === undefined || next.startsWith('--')) {
                    throw new CliError(
                        `${token} needs a value`,
                        `Write it as ${token} <${entry.spec.valueName ?? 'value'}>.`,
                    );
                }
                flags[entry.spec.name] = checkChoice(entry, next);
                index++;
            }
            index++;
            continue;
        }

        if (token.startsWith('-') && token.length === 2) {
            const name = shorts.get(token.slice(1));
            const entry = name ? byName.get(name) : undefined;
            if (!entry) throw unknown(token);
            if (entry.type === 'boolean') {
                flags[entry.spec.name] = true;
            } else {
                const next = argv[index + 1];
                if (next === undefined || next.startsWith('--')) {
                    throw new CliError(
                        `${token} needs a value`,
                        `Write it as ${token} <${entry.spec.valueName ?? 'value'}>.`,
                    );
                }
                flags[entry.spec.name] = checkChoice(entry, next);
                index++;
            }
            index++;
            continue;
        }

        positionals.push(token);
        index++;
    }

    return { flags, positionals };
}

/** Reads a string flag out of parsed flags. */
export function readString(args: ParsedArgs, name: string): string | undefined {
    const value = args.flags[name];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads a boolean flag out of parsed flags. */
export function readBool(args: ParsedArgs, name: string): boolean {
    return args.flags[name] === true;
}
