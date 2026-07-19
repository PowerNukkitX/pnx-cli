import { defineCommand } from 'citty';
import { intro, outro, log, spin } from '../../ui/output.js';
import { c } from '../../ui/theme.js';
import { promptText } from '../../ui/prompts.js';
import { getPluginDetail } from '../../services/plugins.js';
export const infoCmd = defineCommand({
    meta: { description: 'Show plugin details' },
    args: { slug: { type: 'positional', description: 'Plugin slug', required: false } },
    async run({ args }) {
        const slug = args.slug ?? await promptText({ message: "Plugin slug:" });
        const sp = spin(slug);
        try {
            const d = await getPluginDetail(slug);
            sp.stop(d.name);
            intro(`📖 ${d.name}`);
            if (d.description)
                log.dim(d.description);
            log.info(`Author:    ${c.accent(d.author)}`);
            log.info(`Version:   ${c.green(d.latest_version)}`);
            log.info(`Downloads: ${c.cyan(d.downloads >= 1000 ? (d.downloads / 1000).toFixed(1) + 'k' : String(d.downloads))}`);
            log.info(`Updated:   ${new Date(d.updated_at).toLocaleDateString()}`);
            if (d.tags.length)
                log.info(`Tags: ${d.tags.map(tag => c.cyan(tag)).join(', ')}`);
            if (d.repository_url)
                log.info(`Repo: ${c.blue(d.repository_url)}`);
            if (d.releases.length) {
                log.step("Available versions:");
                for (const r of d.releases.slice(0, 5)) {
                    const stable = r.is_stable ? c.green('●') : c.dim('○');
                    log.raw(`  ${stable} v${r.version}  ${c.dim(new Date(r.created_at).toLocaleDateString())}`);
                }
            }
            outro('');
        }
        catch {
            sp.fail(`Plugin not found: ${slug}`);
        }
    },
});
