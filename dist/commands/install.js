import { join } from 'node:path';
import { defineCommand } from 'citty';
import { intro, outro, log, spin, progress } from '../ui/output.js';
import { promptText } from '../ui/prompts.js';
import { resolveServerDir } from '../services/server.js';
import { installApprovedPlugin } from '../services/plugins.js';
export async function runInstall(slug) {
    intro(`📦 ${"Install plugin"}`);
    let name = slug?.trim();
    if (!name) {
        const answer = await promptText({ message: "Plugin slug? (owner.name)", placeholder: 'Owner.Plugin' });
        name = answer?.trim();
    }
    if (!name) {
        log.info("No plugin specified");
        outro('');
        return;
    }
    const serverPath = (await resolveServerDir()) ?? '.';
    const pluginsDir = join(serverPath, 'plugins');
    const sp = spin(name);
    try {
        const entry = await installApprovedPlugin(name, pluginsDir, (pct, f) => progress(pct, f));
        sp.stop(`${entry.name} v${entry.version}`);
        log.success(`Installed ${entry.name}`);
        log.info("Restart the server to load plugins");
    }
    catch (e) {
        const msg = e?.message ?? '';
        if (msg.startsWith('not-approved'))
            sp.fail(`${name} is not approved or does not exist`);
        else if (msg.startsWith('no-file'))
            sp.fail(`No file for ${name}`);
        else
            sp.fail(`Failed to install ${name}`);
    }
    outro('');
}
export const installCmd = defineCommand({
    meta: { name: 'install', description: 'Install an approved plugin by slug (owner.name)' },
    args: { slug: { type: 'positional', description: 'Plugin slug, e.g. RedstoneCloud.CloudBridge', required: false } },
    async run({ args }) {
        await runInstall(args.slug);
    },
});
