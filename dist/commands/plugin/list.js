import { defineCommand } from 'citty';
import { intro, outro, log, spin, isJson, json } from '../../ui/output.js';
import { c } from '../../ui/theme.js';
import { searchPlugins } from '../../services/plugins.js';
function stars(n) {
    const full = '★'.repeat(Math.min(Math.floor(n / 10), 5));
    const empty = '☆'.repeat(5 - full.length);
    return (n >= 50 ? c.yellow : c.dim)(full + empty);
}
function dl(n) { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }
export async function renderList(params) {
    const sp = spin("Fetching from marketplace...");
    try {
        const resp = await searchPlugins(params);
        sp.stop(`${resp.plugins.length} plugins`);
        if (isJson())
            json({ plugins: resp.plugins, count: resp.count });
        intro(`📋 ${"Plugin catalog"}`);
        for (const p of resp.plugins) {
            log.raw(`  ${c.accent.bold(p.name)}  ${c.dim('by ' + p.author)}  ${stars(p.stars)}  ${c.cyan(dl(p.downloads) + ' dl')}  ${c.dim('v' + p.version)}`);
            if (p.description)
                log.raw(`    ${c.dim(p.description)}`);
            log.raw(`    ${c.dim('→')} ${c.blue('pnx plugin install ' + p.slug)}\n`);
        }
        if (resp.count > resp.plugins.length)
            log.info(`${resp.plugins.length}/${resp.count}`);
        outro('');
    }
    catch (e) {
        sp.fail(`Error: ${e.message}`);
    }
}
export const listCmd = defineCommand({
    meta: { description: 'List available plugins' },
    args: {
        sort: { type: 'string', description: 'Sort: newest|updated|stars' },
        limit: { type: 'string', description: 'Results per page', default: '20' },
        page: { type: 'string', description: 'Page number', default: '1' },
        query: { type: 'string', description: 'Search query' },
    },
    run: ({ args }) => renderList({
        sort: args.sort,
        limit: parseInt(args.limit),
        page: parseInt(args.page),
        q: args.query,
    }),
});
