import { CliError, type RunContext } from '../cli/define.js';
import { outroTail } from '../ui/kit.js';
import { isAlive, loadPid, sendControl } from '../services/process.js';

/**
 * `pnx cmd say Hello` - one line typed on the server console from any
 * terminal, through the control socket `pnx start` opens. The answer shows in
 * the server's own window (and its log), not here.
 */
export async function cmdCommand(ctx: RunContext): Promise<void> {
    const line = ctx.args.positionals.join(' ').trim().replace(/^\//, '');
    if (!line) throw new CliError('Nothing to send.', 'Example: `pnx cmd say Hello everyone`.');
    const record = await loadPid();
    if (!record || !isAlive(record.pid)) {
        outroTail('No server is running.', 'fail');
        return;
    }
    if (!record.control) {
        outroTail('This server was not started by `pnx start`, so its console cannot be reached.', 'fail');
        return;
    }
    if (await sendControl(record, line)) outroTail(`Sent: ${line}`, 'ok');
    else outroTail('The server did not take the command.', 'fail');
}
