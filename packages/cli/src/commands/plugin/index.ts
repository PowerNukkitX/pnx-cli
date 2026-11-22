import { renderCommandHelp } from '../../cli/help.js';
import type { CommandSpec, RunContext } from '../../cli/define.js';

/**
 * `pnx plugin` with no verb.
 *
 * Bare, the word is half a command, and the seven things it could mean are one
 * screen away - so this prints the group's help. Verbs, what each does, and
 * the examples the user is likely to type.
 */
export function pluginCommand(ctx: RunContext): Promise<void> {
    const spec: CommandSpec = {
        name: 'plugin',
        group: 'plugins',
        aliases: ['plugins'],
        summary: 'Plugins: list, search, info, install, installed, update, remove',
        positionals: [{ name: 'verb', desc: 'one of: list, search, info, install, installed, update, remove' }],
        examples: [
            'pnx plugin list',
            'pnx plugin search worldedit',
            'pnx plugin install chat-tools',
            'pnx plugin installed',
            'pnx plugin update',
            'pnx plugin remove',
        ],
        run: pluginCommand,
    };
    renderCommandHelp(spec);
    return Promise.resolve();
}
