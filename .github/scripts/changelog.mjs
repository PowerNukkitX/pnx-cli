#!/usr/bin/env node
/*
 * Writes the release notes of @powernukkitx/cli from the git history, in Markdown.
 *
 *   node .github/scripts/changelog.mjs --version 1.4.0 > notes.md
 *
 * Commits are read since the previous cli-v* tag, limited to packages/cli,
 * and grouped by their Conventional
 * Commits type. Bullet lines in a commit body become sub-items, so a commit
 * that explains itself shows up in full.
 */
import { execFileSync } from 'node:child_process';

const args = Object.fromEntries(
    process.argv.slice(2).reduce((pairs, arg, index, all) => {
        if (arg.startsWith('--')) pairs.push([arg.slice(2), all[index + 1]]);
        return pairs;
    }, []),
);

const component = { name: '@powernukkitx/cli', prefix: 'cli-v', paths: ['packages/cli'] };
if (!args.version) {
    console.error('usage: changelog.mjs --version x.y.z [--repo owner/name] [--head ref]');
    process.exit(2);
}
const repo = args.repo ?? process.env.GITHUB_REPOSITORY ?? 'PowerNukkitX/pnx-cli';
const head = args.head ?? 'HEAD';
const tag = `${component.prefix}${args.version}`;

const git = (...argv) => execFileSync('git', argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

/* the newest earlier tag of this component, by version order */
const previous = git('tag', '--list', `${component.prefix}*`, '--sort=-v:refname')
    .split('\n')
    .filter((name) => name && name !== tag)[0];

const range = previous ? `${previous}..${head}` : head;
const SEP = '\x1f';
const END = '\x1e';
const raw = git('log', '--no-merges', `--format=%H${SEP}%s${SEP}%b${SEP}%an${END}`, range, '--', ...component.paths);

const SECTIONS = [
    ['breaking', '⚠️ Breaking changes'],
    ['feat', '✨ Features'],
    ['fix', '🐛 Bug fixes'],
    ['perf', '⚡ Performance'],
    ['refactor', '♻️ Refactoring'],
    ['docs', '📝 Documentation'],
    ['build', '📦 Build and dependencies'],
    ['ci', '🤖 Continuous integration'],
    ['test', '🧪 Tests'],
    ['other', '🔧 Other changes'],
];
const ALIASES = { feature: 'feat', bugfix: 'fix', deps: 'build', chore: 'other', style: 'other', revert: 'other' };
const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<bang>!)?:\s*(?<subject>.+)$/i;

const groups = new Map(SECTIONS.map(([key]) => [key, []]));
const authors = new Set();

for (const record of raw.split(END)) {
    const entry = record.replace(/^\s+/, '');
    if (!entry) continue;
    const [sha, subject, body = '', author] = entry.split(SEP);
    if (/^chore\(release\)/i.test(subject)) continue;
    if (author && !/\[bot\]$/.test(author)) authors.add(author);

    const match = HEADER.exec(subject);
    let type = match ? match.groups.type.toLowerCase() : 'other';
    type = ALIASES[type] ?? type;
    if (!groups.has(type)) type = 'other';
    const breaking = Boolean(match?.groups.bang) || /^BREAKING[ -]CHANGE:/m.test(body);

    const text = match ? match.groups.subject : subject;
    const scope = match?.groups.scope ? `**${match.groups.scope}:** ` : '';
    const link = `([\`${sha.slice(0, 7)}\`](https://github.com/${repo}/commit/${sha}))`;
    // bullet lines of the body become sub-items; indented lines continue the bullet above
    const bullets = [];
    for (const line of body.split('\n')) {
        if (/^\s*[-*]\s+/.test(line)) bullets.push(line.replace(/^\s*[-*]\s+/, '').trim());
        else if (/^\s{2,}\S/.test(line) && bullets.length) bullets[bullets.length - 1] += ` ${line.trim()}`;
    }
    const subItems = bullets.map((text) => `  - ${text}`);

    const item = [`- ${scope}${capitalise(text)} ${link}`, ...subItems].join('\n');
    groups.get(breaking ? 'breaking' : type).push(item);
}

function capitalise(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

const out = [];
out.push(`## ${component.name} ${args.version}`);
out.push('');

const total = [...groups.values()].reduce((sum, list) => sum + list.length, 0);
if (total === 0) {
    out.push('_Maintenance release: no change touched this component since the previous version._');
    out.push('');
}
for (const [key, title] of SECTIONS) {
    const list = groups.get(key);
    if (!list.length) continue;
    out.push(`### ${title}`, '', ...list, '');
}

{
    out.push('### 📥 Install', '');
    out.push('```bash');
    out.push(`npm install -g @powernukkitx/cli@${args.version}`);
    out.push('```');
    out.push('');
}

if (authors.size) {
    out.push(`**Contributors:** ${[...authors].sort((a, b) => a.localeCompare(b)).join(', ')}`);
    out.push('');
}
out.push(
    previous
        ? `**Full changelog:** https://github.com/${repo}/compare/${previous}...${tag}`
        : `**Full changelog:** https://github.com/${repo}/commits/${tag}`,
);

process.stdout.write(`${out.join('\n')}\n`);
