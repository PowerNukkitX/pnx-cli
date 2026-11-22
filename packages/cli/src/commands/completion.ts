import { basename } from 'node:path';
import { CliError, type CommandSpec, type RunContext } from '../cli/define.js';
import { c } from '../ui/theme.js';

/**
 * Tab completion for bash, zsh, fish and PowerShell.
 *
 * The scripts are thin on purpose: each one asks `pnx __complete <words>` what
 * may come next, so completion can never drift from the registry - a new
 * command, alias or option completes the moment it exists. The same call knows
 * live values too: config keys for `config get`, backups for `backup restore`.
 */

const SHELLS = ['bash', 'zsh', 'fish', 'powershell'] as const;
type Shell = (typeof SHELLS)[number];

const SCRIPTS: Record<Shell, string> = {
    bash: `# pnx completion for bash - add to ~/.bashrc:  eval "$(pnx completion bash)"
_pnx_complete() {
    local cur="\${COMP_WORDS[COMP_CWORD]}"
    local IFS=$'\\n'
    COMPREPLY=($(compgen -W "$(pnx __complete "\${COMP_WORDS[@]:1:COMP_CWORD-1}" 2>/dev/null)" -- "$cur"))
}
complete -o default -F _pnx_complete pnx
`,
    zsh: `# pnx completion for zsh - add to ~/.zshrc:  eval "$(pnx completion zsh)"
_pnx() {
    local out
    out="$(pnx __complete "\${(@)words[2,CURRENT-1]}" 2>/dev/null)"
    if [[ -n $out ]]; then
        local -a items
        items=("\${(@f)out}")
        compadd -a items
    else
        _files
    fi
}
(( $+functions[compdef] )) || { autoload -Uz compinit && compinit }
compdef _pnx pnx
`,
    fish: `# pnx completion for fish - save as ~/.config/fish/completions/pnx.fish:
#   pnx completion fish > ~/.config/fish/completions/pnx.fish
function __pnx_complete
    set -l tokens (commandline -opc)
    pnx __complete $tokens[2..-1] 2>/dev/null
end
complete -c pnx -f -a '(__pnx_complete)'
`,
    powershell: `# pnx completion for PowerShell - add to $PROFILE:
#   pnx completion powershell | Out-String | Invoke-Expression
Register-ArgumentCompleter -Native -CommandName pnx -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)
    $words = @($commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.ToString() })
    if ($wordToComplete -ne '') {
        $words = if ($words.Count -gt 1) { $words[0..($words.Count - 2)] } else { @() }
    }
    & pnx __complete @words 2>$null | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
        [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
    }
}
`,
};

const INSTALL: Record<Shell, string> = {
    bash: `echo 'eval "$(pnx completion bash)"' >> ~/.bashrc`,
    zsh: `echo 'eval "$(pnx completion zsh)"' >> ~/.zshrc`,
    fish: 'pnx completion fish > ~/.config/fish/completions/pnx.fish',
    powershell: `Add-Content $PROFILE 'pnx completion powershell | Out-String | Invoke-Expression'`,
};

/** The shell this terminal most likely runs. */
function detectShell(): Shell {
    const name = basename(process.env.SHELL ?? '').toLowerCase();
    if (name.includes('zsh')) return 'zsh';
    if (name.includes('fish')) return 'fish';
    if (name.includes('bash')) return 'bash';
    return process.platform === 'win32' ? 'powershell' : 'bash';
}

export async function completionCommand(ctx: RunContext): Promise<void> {
    const asked = ctx.args.positionals[0]?.toLowerCase().replace(/^pwsh$/, 'powershell');
    if (asked && !SHELLS.includes(asked as Shell)) {
        throw new CliError(`No completion for \`${asked}\`.`, `Pick one of: ${SHELLS.join(', ')}.`);
    }
    const shell = (asked as Shell | undefined) ?? detectShell();

    // a person asking in a terminal wants to know how to turn it on; a pipe or
    // an eval wants the script and nothing else
    if (!asked && process.stdout.isTTY) {
        process.stdout.write(`\n${c.bold('Tab completion')} ${c.muted(`for ${shell}`)}\n\n`);
        process.stdout.write(`  ${c.muted('Turn it on (once):')}\n  ${c.info(INSTALL[shell])}\n\n`);
        process.stdout.write(`  ${c.muted('Then open a new terminal and try')} ${c.info('pnx st<Tab>')}\n`);
        process.stdout.write(`  ${c.muted(`Other shells: pnx completion <${SHELLS.join('|')}>`)}\n\n`);
        return;
    }
    process.stdout.write(SCRIPTS[shell]);
}

/* ── `pnx __complete <words...>`: what may come next ─────────────────────── */

const GLOBAL_FLAGS = ['--help', '--json', '--no-color', '--debug', '--version'];

/** Candidates for the word after `words`, one per line. */
export async function completeWords(words: string[], commands: CommandSpec[]): Promise<string[]> {
    const find = (name: string): CommandSpec | null => commands.find((entry) => entry.name === name || entry.aliases?.includes(name)) ?? null;
    const plain = words.filter((word) => !word.startsWith('-'));

    // walk to the deepest command the words name
    let spec: CommandSpec | null = null;
    let used = 0;
    for (const word of plain) {
        const next: CommandSpec | null = spec ? find(`${spec.name} ${word}`) : find(word);
        if (!next) break;
        spec = next;
        used++;
    }

    if (!spec) {
        if (plain.length > 0) return [];
        const top = commands.flatMap((entry) => [...(entry.name.includes(' ') ? [] : [entry.name]), ...(entry.aliases ?? []).filter((alias) => !alias.includes(' '))]);
        return [...new Set([...top, 'help', 'completion'])].sort();
    }

    // a value is due: offer its choices, or nothing (the shell falls back to files)
    const last = words[words.length - 1];
    if (last?.startsWith('-')) {
        const option = spec.options?.find((entry) => `--${entry.name}` === last || (entry.short && `-${entry.short}` === last));
        if (option?.type === 'string') return option.choices ?? [];
    }

    const subs = commands
        .filter((entry) => entry.name.startsWith(`${spec!.name} `) && entry.name.split(' ').length === spec!.name.split(' ').length + 1)
        .map((entry) => entry.name.split(' ').pop()!);
    const flags = (spec.options ?? []).map((entry) => `--${entry.name}`);
    const argIndex = plain.length - used;
    const values = argIndex === 0 && subs.length === 0 ? await liveValues(spec.name) : [];
    return [...(argIndex === 0 ? subs : []), ...values, ...flags, '--help'];
}

/** Values that only exist on this machine: config keys, backups, plugins. */
async function liveValues(name: string): Promise<string[]> {
    try {
        const { resolveServerDir } = await import('../services/server.js');
        const dir = await resolveServerDir();
        if (!dir) return [];
        if (name === 'config get' || name === 'config set') {
            const { openConfig, leaves } = await import('../services/config-file.js');
            const file = openConfig(dir);
            return file ? leaves(file).map((leaf) => leaf.key) : [];
        }
        if (name === 'backup restore') {
            const { listBackups } = await import('../services/backup.js');
            return ['latest', ...(await listBackups(dir, false)).map((entry) => entry.name)];
        }
        if (name === 'plugin remove') {
            const { readdirSync } = await import('node:fs');
            const { join } = await import('node:path');
            return readdirSync(join(dir, 'plugins')).filter((file) => file.endsWith('.jar')).map((file) => file.replace(/\.jar$/, ''));
        }
    } catch {
        // completion must never print an error into somebody's prompt
    }
    return [];
}

export async function runComplete(words: string[]): Promise<void> {
    const { COMMANDS } = await import('../cli/registry.js');
    const out = await completeWords(words, COMMANDS);
    if (words.length === 0) out.push(...GLOBAL_FLAGS);
    process.stdout.write(out.length ? `${out.join('\n')}\n` : '');
}
