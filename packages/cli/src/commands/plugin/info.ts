import { type RunContext } from '../../cli/define.js';
import { isInteractive, askText, introHead, keyValue, nextSteps, outroTail, spinner, note, log } from '../../ui/kit.js';
import { c, S } from '../../ui/theme.js';
import { getPluginDetail, type PluginDetail } from '../../services/plugins.js';
import { json } from '../../infra/json.js';

/**
 * One plugin, in full.
 *
 * The detail screen. Only the version is coloured - it is the one value
 * somebody is usually cross-checking against what the server has loaded - so
 * every other field reads as a fact rather than an opinion about itself.
 */

export function pluginCard(detail: PluginDetail): void {
    if (detail.description) log.message(c.muted(detail.description));

    keyValue(
        {
            Author: detail.author,
            Version: c.brand(`v${detail.latest_version}`),
            Downloads: detail.downloads >= 1000 ? `${(detail.downloads / 1000).toFixed(1)}k` : String(detail.downloads),
            Updated: new Date(detail.updated_at).toLocaleDateString(),
            Tags: detail.tags?.length ? c.muted(detail.tags.join(', ')) : undefined,
            Repository: detail.repository_url ? c.muted(detail.repository_url) : undefined,
        },
        detail.name,
    );

    if (detail.releases?.length) {
        note(
            detail.releases
                .slice(0, 5)
                .map((release) =>
                    `${release.is_stable ? c.success(S.dot) : c.muted(S.ring)}  v${release.version}  ${c.muted(new Date(release.created_at).toLocaleDateString())}`,
                )
                .join('\n'),
            'Recent releases',
        );
    }
}

export async function runPluginInfo(slugFromArgs?: string): Promise<void> {
    let slug = slugFromArgs;
    if (!slug) {
        if (!isInteractive()) {
            outroTail('Give a slug: pnx plugin info <slug>', 'fail');
            return;
        }
        slug = await askText({ message: 'Plugin name (slug)', placeholder: 'chat-tools' });
    }

    const sp = spinner();
    sp.start(`Fetching ${slug}...`);
    let detail: PluginDetail;
    try {
        detail = await getPluginDetail(slug!);
    } catch {
        sp.error(`No plugin called ${slug}`);
        nextSteps([['pnx plugin search <term>', 'search by name instead']], 'Try');
        outroTail('Nothing to show.', 'fail');
        return;
    }
    sp.stop(detail.name);

    if (json.isJson()) {
        json.emit(detail);
        return;
    }

    introHead('pnx plugin info', c.muted(slug!));
    pluginCard(detail);
    nextSteps([[`pnx plugin install ${slug}`, 'install it here']]);
    outroTail(`${detail.name} v${detail.latest_version}`);
}

export async function infoCommand(ctx: RunContext): Promise<void> {
    await runPluginInfo(ctx.args.positionals[0]);
}
