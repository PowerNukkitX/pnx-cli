import * as clack from '@clack/prompts';
import { c, chalk } from './theme.js';
const _isJson = process.argv.includes('--json');
export function isJson() { return _isJson; }
export function json(data) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    process.exit(0);
}
export function intro(title) {
    if (_isJson)
        return;
    clack.intro(c.primary.bold(` ${title} `));
}
export function outro(msg) {
    if (_isJson)
        return;
    clack.outro(c.accent(msg));
}
export function section(title) {
    if (_isJson)
        return;
    clack.log.step(c.accent.bold(title));
}
export function cancel(msg = 'Cancelled') {
    if (!_isJson)
        clack.cancel(c.yellow(msg));
    process.exit(0);
}
export function spin(msg) {
    if (_isJson)
        return { update: () => { }, stop: () => { }, fail: () => { } };
    const s = clack.spinner();
    s.start(msg);
    return {
        update: m => s.message(m),
        stop: m => s.stop(m),
        fail: m => s.stop(m, 1),
    };
}
export const log = {
    success: (msg) => { if (!_isJson)
        clack.log.success(c.green(msg)); },
    error: (msg) => { if (!_isJson)
        clack.log.error(c.red(msg)); },
    warn: (msg) => { if (!_isJson)
        clack.log.warn(c.yellow(msg)); },
    info: (msg) => { if (!_isJson)
        clack.log.info(c.blue(msg)); },
    step: (msg) => { if (!_isJson)
        clack.log.step(chalk.dim(msg)); },
    dim: (msg) => { if (!_isJson)
        clack.log.message(chalk.dim(msg)); },
    raw: (msg) => { if (!_isJson)
        process.stdout.write(msg + '\n'); },
};
export function progress(pct, label) {
    if (_isJson)
        return;
    const clamped = Math.max(0, Math.min(100, pct));
    const filled = Math.floor(clamped / 5);
    const bar = c.cyan('━'.repeat(filled)) + chalk.dim('─'.repeat(20 - filled));
    const suffix = label ? `  ${chalk.dim(label)}` : '';
    process.stdout.write(`\r  ${bar}  ${chalk.bold(String(clamped))}%${suffix}`);
    if (clamped >= 100)
        process.stdout.write('\n');
}
export { clack };
