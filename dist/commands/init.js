import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { cwd } from 'node:process';
import { defineCommand } from 'citty';
import { intro, outro, log, spin, progress, isJson } from '../ui/output.js';
import { promptText, promptConfirm, promptSelect } from '../ui/prompts.js';
import { listReleases, downloadCore } from '../services/release.js';
import { startScripts, setDefaultServer } from '../services/server.js';
import { downloadFile } from '../infra/http.js';
import { JAR_NAME } from '../infra/paths.js';
export const initCmd = defineCommand({
    meta: { description: 'Create a new PowerNukkitX server' },
    args: {
        dir: { type: 'string', description: 'Target directory' },
        version: { type: 'string', description: 'Version to install (tag), skips the picker' },
        dev: { type: 'boolean', description: 'Install dev version', default: false },
    },
    async run({ args }) {
        intro(`⚡ ${"Create a PowerNukkitX server"}`);
        let target = args.dir;
        if (!target) {
            target = await promptText({
                message: "Server directory?",
                defaultValue: 'pnx-server',
                validate: v => {
                    if (!v || !v.trim())
                        return 'Required';
                    if (existsSync(join(resolve(cwd(), v), JAR_NAME)))
                        return "A server already exists here";
                    return undefined;
                },
            });
        }
        const serverDir = resolve(cwd(), target);
        if (existsSync(join(serverDir, JAR_NAME)) && args.dir) {
            log.error("A server already exists here");
            process.exit(1);
        }
        try {
            const sp = spin("Fetching versions...");
            const releases = await listReleases();
            sp.stop(`${String(releases.length)} versions found`);
            if (releases.length === 0)
                throw new Error("No releases available");
            let release;
            if (args.version) {
                const wanted = args.version.replace(/^v/, '');
                release = releases.find(r => r.tag === args.version || r.version === wanted);
                if (!release)
                    throw new Error(`Version ${args.version} not found`);
            }
            else if (isJson()) {
                release = releases[0];
            }
            else {
                const chosen = await promptSelect("Select a version", releases.map((r, i) => ({
                    value: r.tag,
                    label: i === 0 ? `${r.tag} (${"latest"})` : r.tag,
                    hint: r.prerelease ? "pre-release" : undefined,
                })));
                release = releases.find(r => r.tag === chosen) ?? releases[0];
            }
            await mkdir(serverDir, { recursive: true });
            log.step("Downloading");
            const { size } = await downloadCore(release, join(serverDir, JAR_NAME), pct => progress(pct, JAR_NAME));
            log.success(`Downloaded (${(size / 1024 / 1024).toFixed(1)} MB)`);
            const sp2 = spin("Downloading start scripts...");
            for (const s of startScripts())
                await downloadFile(s.url, join(serverDir, s.name));
            sp2.stop("Start scripts downloaded");
            await setDefaultServer(serverDir);
            log.success("Server ready!");
            if (await promptConfirm("Start the server now?", false)) {
                const { runStart } = await import('./start.js');
                await runStart({ dir: serverDir });
            }
            else {
                outro("Server ready!");
            }
        }
        catch (e) {
            log.error(e.message);
            process.exit(1);
        }
    },
});
