import type { CommandSpec } from './define.js';
import type { GroupSpec } from './help.js';
import { readString, readBool } from './define.js';
import { runCreate, printCreateSummary } from '../commands/create.js';
import { startCommand } from '../commands/start.js';
import { stopCommand } from '../commands/stop.js';
import { logsCommand } from '../commands/logs.js';
import { consoleCommand } from '../commands/console.js';
import { configCommand, configGetCommand, configSetCommand } from '../commands/config.js';
import { useCommand } from '../commands/use.js';
import { updateCommand } from '../commands/update.js';
import { backupCommand, backupListCommand, backupRestoreCommand, backupPruneCommand } from '../commands/backup.js';
import { statusCommand } from '../commands/status.js';
import { openCommand } from '../commands/open.js';
import { completionCommand } from '../commands/completion.js';
import { doctorCommand } from '../commands/doctor.js';
import { infoCommand } from '../commands/info.js';
import { runLink } from '../commands/link.js';
import { cmdCommand } from '../commands/cmd.js';
import { pluginCommand } from '../commands/plugin/index.js';
import { listCommand } from '../commands/plugin/list.js';
import { searchCommand } from '../commands/plugin/search.js';
import { infoCommand as pluginInfoCommand } from '../commands/plugin/info.js';
import { installCommand } from '../commands/plugin/install.js';
import { updateCommand as pluginUpdateCommand } from '../commands/plugin/update.js';
import { removeCommand } from '../commands/plugin/remove.js';
import { runInstalledPlugins } from '../commands/plugin/installed.js';

/**
 * Every command, once, in the order a person meets them.
 *
 * Three readers derive from this list: the dispatcher, the help screen, and the
 * did-you-mean suggestion. Spelling the list three times is how a tool ends up
 * with a command that works but is documented nowhere; here the list is the
 * single fact and everything else is derived.
 *
 * The groups match the launcher on purpose: somebody who learned the tool
 * through the menu already knows where to look.
 */
export const GROUPS: GroupSpec[] = [
    { id: 'server', title: 'Server', hint: 'create, run and inspect' },
    { id: 'plugins', title: 'Plugins', hint: 'find, install and remove' },
    { id: 'dashboard', title: 'Dashboard', hint: 'pair with a hub' },
    { id: 'maintenance', title: 'Maintenance', hint: 'backups, updates, diagnostics' },
];

export const COMMANDS: CommandSpec[] = [
    {
        name: 'init',
        group: 'server',
        aliases: ['new', 'create'],
        summary: 'Create a server: download PowerNukkitX and its start scripts',
        description: 'Walks directory → version → download → start scripts. Interactive when it can be, fully scripted otherwise; --yes takes every default.',
        positionals: [{ name: 'dir', desc: 'Folder to create; asked for when omitted' }],
        options: [
            { name: 'version', type: 'string', desc: 'Version tag, skips the picker', valueName: 'tag' },
            { name: 'yes', short: 'y', type: 'boolean', desc: 'Use the defaults: ./pnx-server and the latest stable release', default: false },
            { name: 'dir', type: 'string', desc: 'Same as the argument', valueName: 'path' },
        ],
        examples: ['pnx init', 'pnx init my-server', 'pnx init -y', 'pnx init survival --version v3.0.6'],
        run: async (ctx) => {
            const result = await runCreate({
                dir: ctx.args.positionals[0] ?? readString(ctx.args, 'dir'),
                version: readString(ctx.args, 'version'),
                yes: readBool(ctx.args, 'yes'),
            });
            printCreateSummary(result);
        },
    },
    {
        name: 'start',
        group: 'server',
        aliases: ['run', 'up'],
        summary: 'Run the server here (Ctrl+C saves and stops it)',
        positionals: [{ name: 'dir', desc: 'Server folder; the default server when omitted' }],
        options: [
            { name: 'memory', short: 'm', type: 'string', desc: 'Most memory the server may use (2G, 4G, 3072M...)', valueName: 'size', default: '2G' },
            { name: 'restart', short: 'r', type: 'boolean', desc: 'Start it again after a crash (3 times in 10 min at most)', default: false },
            { name: 'dir', type: 'string', desc: 'Server folder (same as the argument)', valueName: 'path' },
            { name: 'dry-run', type: 'boolean', desc: 'Print the java command instead of running it' },
            { name: 'verbose', short: 'V', type: 'boolean', desc: 'Show the whole boot log instead of the spinner', default: false },
        ],
        examples: ['pnx start', 'pnx start -m 4G --restart', 'pnx start ./my-server', 'pnx start --verbose', 'pnx start --dry-run'],
        run: startCommand,
    },
    {
        name: 'stop',
        group: 'server',
        aliases: ['down'],
        summary: 'Save the world and stop the server',
        options: [
            { name: 'force', short: 'f', type: 'boolean', desc: 'Kill it instead (unsaved progress is lost)', default: false },
        ],
        examples: ['pnx stop', 'pnx stop --force'],
        run: stopCommand,
    },
    {
        name: 'cmd',
        group: 'server',
        aliases: ['send', 'exec'],
        summary: 'Type a command on the running server\'s console',
        positionals: [{ name: 'command', desc: 'The console command, e.g. `say Hello` or `op Steve`', required: true }],
        examples: ['pnx cmd say Server restarts in 5 minutes', 'pnx cmd op Steve', 'pnx cmd save-all'],
        run: cmdCommand,
    },
    {
        name: 'status',
        group: 'server',
        aliases: ['ps'],
        summary: 'Is it running, since when, and the address players join',
        description: 'Live state (PID, uptime), the UDP port from pnx.yml, every LAN address to join from, plugins, worlds and the last backup.',
        examples: ['pnx status', 'pnx --json status'],
        run: statusCommand,
    },
    {
        name: 'console',
        group: 'server',
        summary: 'Open a console over RCON (needs RCON enabled)',
        examples: ['pnx console'],
        run: consoleCommand,
    },
    {
        name: 'logs',
        group: 'server',
        aliases: ['log'],
        summary: 'Read the server log, and follow it',
        options: [
            { name: 'lines', short: 'n', type: 'string', desc: 'How many lines to show', valueName: 'n', default: '50' },
            { name: 'follow', type: 'boolean', desc: 'Follow new output as it is written', default: true },
        ],
        examples: ['pnx logs', 'pnx logs --lines 200', 'pnx logs --no-follow'],
        run: logsCommand,
    },
    {
        name: 'config',
        group: 'server',
        summary: 'Show the configuration the server reads',
        description: 'Prints pnx.yml (or server.properties) as written. `config get` / `config set` read and change one value by its dotted key, keeping every comment.',
        examples: ['pnx config', 'pnx config get settings.port', 'pnx config set settings.motd "Survival"', 'pnx --json config'],
        run: configCommand,
    },
    {
        name: 'config get',
        group: 'server',
        summary: 'Print one configuration value',
        description: 'The key is dotted (`settings.port`); a unique last segment is enough (`port`). Prints the bare value, ready for a script.',
        positionals: [{ name: 'key', desc: 'Dotted key, e.g. settings.port', required: true }],
        examples: ['pnx config get settings.port', 'pnx config get motd'],
        run: configGetCommand,
    },
    {
        name: 'config set',
        group: 'server',
        summary: 'Change one configuration value, comments kept',
        description: 'Rewrites only the value on that one line. Restart the server for it to take effect.',
        positionals: [
            { name: 'key', desc: 'Dotted key, e.g. settings.maxPlayers', required: true },
            { name: 'value', desc: 'The new value (words are joined)', required: true },
        ],
        examples: ['pnx config set settings.maxPlayers 50', 'pnx config set settings.motd "Survival"', 'pnx config set allowList true'],
        run: configSetCommand,
    },
    {
        name: 'open',
        group: 'server',
        summary: 'Open the server folder (or its config, logs, plugins...) on this machine',
        positionals: [{ name: 'what', desc: 'folder | config | logs | plugins | backups | worlds' }],
        examples: ['pnx open', 'pnx open config', 'pnx open plugins'],
        run: openCommand,
    },
    {
        name: 'use',
        group: 'server',
        summary: 'Pick the server every command works on',
        positionals: [{ name: 'dir', desc: 'Server path to make the default' }],
        options: [
            { name: 'clear', type: 'boolean', desc: 'Forget the default again', default: false },
        ],
        examples: ['pnx use', 'pnx use ./my-server', 'pnx use --clear'],
        run: useCommand,
    },
    {
        name: 'plugin',
        group: 'plugins',
        aliases: ['plugins'],
        summary: 'Plugins: list, search, install, update, remove',
        hidden: true,
        examples: ['pnx plugin list', 'pnx plugin search worldedit', 'pnx plugin install'],
        run: pluginCommand,
    },

    /* -- `pnx plugin <verb>` lives here too, but speaks full names -- */
    {
        name: 'plugin list',
        group: 'plugins',
        aliases: ['plugins list'],
        summary: 'Browse the marketplace, most starred first',
        options: [
            { name: 'sort', type: 'string', desc: 'newest | updated | stars', valueName: 'order', default: 'stars', choices: ['stars', 'newest', 'updated'] },
            { name: 'limit', type: 'string', desc: 'Results per page', valueName: 'n', default: '20' },
            { name: 'page', type: 'string', desc: 'Page number', valueName: 'n', default: '1' },
            { name: 'query', type: 'string', desc: 'Search text', valueName: 'text' },
        ],
        examples: ['pnx plugin list', 'pnx plugin list --query chat'],
        run: listCommand,
    },
    {
        name: 'plugin search',
        group: 'plugins',
        aliases: ['search', 'plugins search'],
        summary: 'Search the marketplace by name',
        positionals: [{ name: 'term', desc: 'Words from a plugin name; asked for when omitted' }],
        examples: ['pnx plugin search worldedit'],
        run: searchCommand,
    },
    {
        name: 'plugin info',
        group: 'plugins',
        aliases: ['plugins info'],
        summary: 'Show one plugin in full',
        positionals: [{ name: 'slug', desc: 'The plugin as the marketplace names it, owner.name' }],
        examples: ['pnx plugin info chat-tools'],
        run: pluginInfoCommand,
    },
    {
        name: 'plugin install',
        group: 'plugins',
        aliases: ['install', 'add', 'plugins install'],
        summary: 'Install plugins from the hub (only reviewed releases)',
        positionals: [{ name: 'slugs', desc: 'Plugin slugs or .jar URLs, one or many' }],
        examples: ['pnx plugin install', 'pnx plugin install chat-tools', 'pnx plugin install https://host/plugin.jar'],
        run: installCommand,
    },
    {
        name: 'plugin installed',
        group: 'plugins',
        aliases: ['plugins installed'],
        summary: 'List what is in the plugins/ folder',
        examples: ['pnx plugin installed', 'pnx --json plugin installed'],
        run: async () => runInstalledPlugins(),
    },
    {
        name: 'plugin update',
        group: 'plugins',
        aliases: ['plugins update'],
        summary: 'Update plugins to their newest release',
        positionals: [{ name: 'slugs', desc: 'Plugin slugs; every tracked plugin when omitted' }],
        examples: ['pnx plugin update', 'pnx plugin update chat-tools'],
        run: pluginUpdateCommand,
    },
    {
        name: 'plugin remove',
        group: 'plugins',
        aliases: ['uninstall', 'plugins remove'],
        summary: 'Remove plugins from the folder',
        positionals: [{ name: 'names', desc: 'Plugin names; picked from a list when omitted' }],
        examples: ['pnx plugin remove', 'pnx plugin remove chat-tools'],
        run: removeCommand,
    },

    {
        name: 'link',
        group: 'dashboard',
        summary: 'Pair this server with a hub, and supervise it',
        positionals: [{ name: 'code', desc: 'Pairing code shown by the dashboard' }],
        options: [
            { name: 'hub', type: 'string', desc: 'Hub base URL', valueName: 'url', default: 'https://powernukkitx.org' },
            { name: 'allow', type: 'string', desc: 'Capabilities to grant, comma separated', valueName: 'list' },
            { name: 'dir', type: 'string', desc: 'Server directory', valueName: 'path' },
            { name: 'memory', type: 'string', desc: 'Memory for the server', valueName: 'size', default: '2G' },
            { name: 'name', type: 'string', desc: 'Label shown on the dashboard', valueName: 'label' },
            { name: 'start', type: 'boolean', desc: 'Start the server on launch (--no-start to attach only)', default: true },
            { name: 'status', type: 'boolean', desc: 'Show what this machine is paired with', default: false },
            { name: 'forget', type: 'boolean', desc: 'Delete the stored token', default: false },
        ],
        examples: ['pnx link --status', 'pnx link ABCD-1234', 'pnx link'],
        run: async (ctx) => {
            await runLink({
                code: ctx.args.positionals[0],
                hub: (readString(ctx.args, 'hub') ?? 'https://powernukkitx.org').replace(/\/$/, ''),
                allow: readString(ctx.args, 'allow'),
                dir: readString(ctx.args, 'dir'),
                memory: readString(ctx.args, 'memory'),
                name: readString(ctx.args, 'name'),
                start: readBool(ctx.args, 'start'),
                status: readBool(ctx.args, 'status'),
                forget: readBool(ctx.args, 'forget'),
            });
        },
    },


    {
        name: 'update',
        group: 'maintenance',
        aliases: ['upgrade'],
        summary: 'Update the server to the latest PowerNukkitX release',
        options: [
            { name: 'force', type: 'boolean', desc: 'Bypass the release cache', default: false },
        ],
        examples: ['pnx update', 'pnx update --force'],
        run: updateCommand,
    },
    {
        name: 'backup',
        group: 'maintenance',
        summary: 'Copy worlds, plugins and configuration into backups/',
        options: [
            { name: 'keep', type: 'string', desc: 'Then delete all but the newest <n> backups', valueName: 'n' },
        ],
        examples: ['pnx backup', 'pnx backup --keep 7', 'pnx backup list', 'pnx backup restore latest'],
        run: backupCommand,
    },
    {
        name: 'backup list',
        group: 'maintenance',
        aliases: ['backups'],
        summary: 'Every backup, newest first, with its size and age',
        examples: ['pnx backup list', 'pnx --json backup list'],
        run: async () => backupListCommand(),
    },
    {
        name: 'backup restore',
        group: 'maintenance',
        summary: 'Put a backup back in place (a safety copy is taken first)',
        positionals: [{ name: 'backup', desc: 'latest, a number from `backup list`, or a name; picked from a list when omitted' }],
        options: [
            { name: 'yes', short: 'y', type: 'boolean', desc: 'Do not ask for confirmation (scripts)', default: false },
        ],
        examples: ['pnx backup restore', 'pnx backup restore latest', 'pnx backup restore 3 --yes'],
        run: backupRestoreCommand,
    },
    {
        name: 'backup prune',
        group: 'maintenance',
        summary: 'Delete old backups, keeping the newest few',
        options: [
            { name: 'keep', type: 'string', desc: 'How many to keep', valueName: 'n', default: '5' },
        ],
        examples: ['pnx backup prune', 'pnx backup prune --keep 10'],
        run: backupPruneCommand,
    },
    {
        name: 'doctor',
        group: 'maintenance',
        aliases: ['check'],
        summary: 'Check Java, memory, disk and port before starting',
        examples: ['pnx doctor', 'pnx --json doctor'],
        run: doctorCommand,
    },
    {
        name: 'info',
        group: 'maintenance',
        summary: 'Show the server, its version and this machine',
        examples: ['pnx info', 'pnx --json info'],
        run: infoCommand,
    },
    {
        name: 'completion',
        group: 'maintenance',
        summary: 'Tab completion for bash, zsh, fish and PowerShell',
        description: 'Without a shell name in a terminal, prints the one line that turns it on. With one, prints the script. Completes commands, options, config keys and backup names.',
        positionals: [{ name: 'shell', desc: 'bash | zsh | fish | powershell' }],
        examples: ['pnx completion', 'pnx completion zsh', 'pnx completion powershell | Out-String | Invoke-Expression'],
        run: completionCommand,
    },
];

/** Any full name or alias resolves to its spec. */
export function findCommand(name: string): CommandSpec | null {
    return COMMANDS.find((entry) => entry.name === name || entry.aliases?.includes(name)) ?? null;
}
