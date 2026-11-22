import { readString, type RunContext } from '../../cli/define.js';
import { empty, introHead, nextSteps, outroTail, spinner, log } from '../../ui/kit.js';
import { c, S } from '../../ui/theme.js';
import { searchPlugins, type PluginSummary, type SearchParams } from '../../services/plugins.js';
import { json } from '../../infra/json.js';

/**
 * The marketplace, listed.
 *
 * One plugin, in three lines: the name in brand red - the only colour on its
 * line - then the facts on a quiet line below, then the literal command to
 * install it. A scan down the page hits a name, then the line worth copying,
 * and skips everything in between.
 */

function fmtDownloads(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function line(entry: PluginSummary['plugins'][number]): void {
    const facts = [
        entry.author,
        `${entry.stars} stars`,
        `${fmtDownloads(entry.downloads)} downloads`,
        `v${entry.version}`,
    ].join(`  ${S.bullet}  `);
    log.step(`${c.brand(entry.name)}  ${c.muted(facts)}`);
    if (entry.description) log.message(c.muted(entry.description));
    log.message(`${c.muted(S.arrow)} ${c.info(`pnx plugin install ${entry.slug}`)}`);
    log.message('');
}

export async function renderList(params: SearchParams): Promise<void> {
    const isJsonMode = json.isJson();
    if (!isJsonMode) introHead('pnx plugin list', 'from the marketplace');

    const sp = spinner();
    sp.start('Fetching the marketplace...');
    let response: PluginSummary;
    try {
        response = await searchPlugins(params);
    } catch (cause) {
        sp.error('Could not reach the marketplace');
        log.message(c.muted(cause instanceof Error ? cause.message : String(cause)));
        outroTail('Check the connection and try again.', 'fail');
        return;
    }
    sp.stop(`${response.plugins.length} of ${response.count} plugins`);

    if (isJsonMode) {
        json.emit({ plugins: response.plugins, count: response.count });
        return;
    }

    if (response.plugins.length === 0) {
        empty('Nothing matched that.', [
            ['pnx plugin list', 'browse everything, most starred first'],
        ]);
        outroTail('No results.');
        return;
    }
    for (const plugin of response.plugins) line(plugin);
    if (response.count > response.plugins.length) {
        log.message(c.muted(`Showing ${response.plugins.length} of ${response.count}. Use --page and --limit for the rest.`));
    }
    outroTail('Install any of them with the command under its name.');
}

/** The shared command handler. */
export function listCommand(ctx: RunContext): Promise<void> {
    return renderList({
        sort: (readString(ctx.args, 'sort') as SearchParams['sort']) ?? 'stars',
        limit: parseInt(readString(ctx.args, 'limit') ?? '20', 10),
        page: parseInt(readString(ctx.args, 'page') ?? '1', 10),
        q: readString(ctx.args, 'query'),
    });
}
