import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createConnection, Socket } from 'node:net';
import { type RunContext } from '../cli/define.js';
import { introHead, note, nextSteps, outroTail } from '../ui/kit.js';
import { c, S } from '../ui/theme.js';
import { resolveServerDir } from '../services/server.js';

/**
 * The console, over RCON.
 *
 * The thing this cannot be is a second `pnx start`: the real console is the
 * terminal the server itself ran in, with its colors and Ctrl-C. This is the
 * window into it, for when the server was started on another screen or by
 * something else entirely. Off by default, because RCON is a socket and a
 * password, and somebody who did not opt in should not have one.
 */

interface RconConnection {
    send: (command: string) => void;
    close: () => void;
}

function parseServerProperties(serverPath: string): Record<string, string> {
    const propsPath = join(serverPath, 'server.properties');
    if (!existsSync(propsPath)) return {};
    const props: Record<string, string> = {};
    for (const line of readFileSync(propsPath, 'utf-8').split('\n')) {
        if (line.startsWith('#') || !line.includes('=')) continue;
        const [key, ...rest] = line.split('=');
        props[key!.trim()] = rest.join('=').trim();
    }
    return props;
}

/** RCON framing: [length][id][type][body..][two nulls]. */
function rconPacket(id: number, type: number, body: string): Buffer {
    const bodyBuf = Buffer.from(body + '\0\0', 'utf-8');
    const packet = Buffer.alloc(12 + bodyBuf.length);
    packet.writeInt32LE(8 + bodyBuf.length, 0);
    packet.writeInt32LE(id, 4);
    packet.writeInt32LE(type, 8);
    bodyBuf.copy(packet, 12);
    return packet;
}

function connectRcon(host: string, port: number, password: string): Promise<RconConnection | null> {
    return new Promise((resolvePromise) => {
        const socket: Socket = createConnection({ host, port }, () => socket.write(rconPacket(1, 3, password)));
        socket.once('data', (data: Buffer) => {
            if (data.readInt32LE(4) === -1) {
                socket.destroy();
                resolvePromise(null);
                return;
            }
            resolvePromise({
                send: (command) => {
                    socket.write(rconPacket(2, 2, command));
                    socket.once('data', (d: Buffer) => {
                        const response = d.subarray(12, d.length - 2).toString('utf-8');
                        if (response) process.stdout.write(`${response}\n`);
                    });
                },
                close: () => socket.destroy(),
            });
        });
        socket.on('error', () => resolvePromise(null));
        setTimeout(() => resolvePromise(null), 3000);
    });
}

export async function runConsole(): Promise<void> {
    introHead('pnx console', 'type into the server over RCON');

    const serverPath = await resolveServerDir();
    if (!serverPath) {
        nextSteps([['pnx init', 'create one'], ['pnx use <path>', 'point at an existing one']], 'Try');
        outroTail('Not connected.', 'fail');
        return;
    }

    const props = parseServerProperties(serverPath);
    const enabled = props['enable-rcon'] === 'true';
    const port = Number.parseInt(props['rcon.port'] ?? '25575', 10);
    const password = props['rcon.password'] ?? '';

    if (enabled && password) {
        process.stdout.write(`${c.dim(`Dialing 127.0.0.1:${port}...`)}\n`);
        const rcon = await connectRcon('127.0.0.1', port, password);
        if (rcon) {
            process.stdout.write(`${c.success(S.check)} Connected. Type a server command, or \`exit\` to leave.\n\n`);
            const readline = createInterface({ input: process.stdin, output: process.stdout, prompt: 'pnx> ' });
            await new Promise<void>((resolveConsole) => {
                let left = false;
                const leave = () => {
                    if (left) return;
                    left = true;
                    rcon.close();
                    readline.close();
                    process.stdin.pause();
                    resolveConsole();
                };
                readline.prompt();
                readline.on('line', (line: string) => {
                    const command = line.trim();
                    if (command === 'exit') { leave(); return; }
                    if (command.length > 0) rcon.send(command);
                    readline.prompt();
                });
                readline.on('SIGINT', leave);
                readline.on('close', leave);
            });
            outroTail('Disconnected.');
            return;
        }
        process.stdout.write(`${c.error(S.cross)} The server did not answer on that port.\n`);
        process.stdout.write(`${c.muted('It may not be running, or the password in server.properties has moved on.')}\n\n`);
        outroTail('Not connected.', 'fail');
        return;
    }

    nextSteps(
        [
            ['pnx config', 'see the current server.properties first'],
            ['pnx stop', 'stop the server before editing'],
        ],
        'Why',
    );
    note(
        `enable-rcon=true\nrcon.port=${port}\nrcon.password=choose-something`,
        enabled ? 'RCON is on but no password is set - add to server.properties' : 'RCON is switched off - add to server.properties',
    );
    outroTail('Then restart and run `pnx console` again. Or skip RCON: `pnx cmd <command>` works on servers started with pnx start.', 'fail');
}

export function consoleCommand(ctx: RunContext): Promise<void> {
    void ctx;
    return runConsole();
}
