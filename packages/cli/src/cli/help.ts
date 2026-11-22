import { c, gradient, S } from '../ui/theme.js';
import type { CommandSpec } from './define.js';

/**
 * Screens made for scanning.
 *
 * A help screen is read when a spelling failed, so its one job is to hand over
 * the correct name in under a second. Everything here is laid out for that
 * scan: groups before commands, summaries in their own column, and examples
 * only where they are more useful than a summary.
 */

export interface GroupSpec {
    id: string;
    title: string;
    hint: string;
}

/** Turns a command's usage into one copyable line. */
function usageLine(spec: CommandSpec): string {
    const parts = [`pnx ${spec.name}`];
    for (const arg of spec.positionals ?? []) {
        parts.push(arg.required ? `<${arg.name}>` : `[${arg.name}]`);
    }
    if (spec.options?.length) parts.push('[options]');
    return parts.join(' ');
}

/** One command's options and positionals, as aligned rows. */
function optionRows(spec: CommandSpec): Array<[string, string]> {
    const rows: Array<[string, string]> = [];
    for (const arg of spec.positionals ?? []) {
        rows.push([`<${arg.name}>`, arg.desc ?? '']);
    }
    for (const option of spec.options ?? []) {
        const left = [
            option.short ? `-${option.short}, ` : '    ',
            `--${option.name}${option.valueName ? ` <${option.valueName}>` : ''}`,
        ].join('');
        rows.push([left, option.desc ?? '']);
    }
    return rows;
}

const w = (line = ''): void => { process.stdout.write(`${line}\n`); };

/** `pnx --help`: what to type first, then every command by group. */
export function renderRootHelp(commands: CommandSpec[], groups: GroupSpec[], version: string): void {
    const visible = commands.filter((entry) => !entry.hidden);
    const col = Math.min(24, Math.max(...visible.map((entry) => entry.name.length)) + 2);
    w();
    w(`${c.brand(S.logo)} ${c.bold(gradient('PowerNukkitX CLI'))} ${c.muted(`v${version}`)}`);
    w(c.muted('  Create, run and look after Minecraft Bedrock servers.'));
    w();
    w(`${c.bold('Usage:')} pnx ${c.info('<command>')} ${c.muted('[options]')}`);
    w();
    w(c.bold('Start here'));
    w(`  ${c.info('pnx init'.padEnd(col))}create a server in this folder`);
    w(`  ${c.info('pnx start'.padEnd(col))}run it ${c.muted('(Ctrl+C stops it cleanly)')}`);
    w(`  ${c.info('pnx status'.padEnd(col))}is it up, and the address players join`);
    w(`  ${c.info('pnx'.padEnd(col))}${c.muted('or pick from a menu')}`);
    w();
    for (const group of groups) {
        const entries = visible.filter((entry) => entry.group === group.id);
        if (entries.length === 0) continue;
        w(`${c.bold(group.title)} ${c.muted(`- ${group.hint}`)}`);
        for (const entry of entries) w(`  ${c.info(entry.name.padEnd(col))}${entry.summary}`);
        w();
    }
    w(c.bold('Global options'));
    w(`  ${c.info('-h, --help'.padEnd(col))}help for pnx, or for one command`);
    w(`  ${c.info('-v, --version'.padEnd(col))}print the version`);
    w(`  ${c.info('--json'.padEnd(col))}machine-readable output`);
    w(`  ${c.info('--no-color'.padEnd(col))}plain text ${c.muted('(also NO_COLOR=1; --color / FORCE_COLOR=1 force it on)')}`);
    w(`  ${c.info('--debug'.padEnd(col))}full stack trace under an error`);
    w();
    w(c.muted('Short forms work: pnx install <name>, pnx search <word>, pnx uninstall <name>.'));
    w(c.muted('More on any command: pnx <command> --help   Tab completion: pnx completion'));
    w();
}

/** `pnx <command> --help`. */
export function renderCommandHelp(spec: CommandSpec): void {
    w();
    w(`${c.brand(S.logo)} ${c.bold(`pnx ${spec.name}`)}  ${spec.summary}`);
    if (spec.description) { w(); w(spec.description); }
    w();
    w(c.bold('Usage'));
    w(`  ${c.brand(usageLine(spec))}`);
    const rows = optionRows(spec);
    if (rows.length > 0) {
        const width = Math.max(...rows.map(([left]) => left.length));
        w();
        w(c.bold('Options'));
        for (const [left, right] of rows) w(`  ${c.info(left.padEnd(width))}  ${right}`);
    }
    if (spec.examples?.length) {
        w();
        w(c.bold('Examples'));
        for (const example of spec.examples) w(`  ${c.brand(example)}`);
    }
    if (spec.aliases?.length) { w(); w(c.muted(`Also: ${spec.aliases.join(', ')}`)); }
    w();
}
