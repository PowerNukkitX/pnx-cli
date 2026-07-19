import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createConnection } from 'node:net';
import { defineCommand } from 'citty';
import { intro, outro, log } from '../ui/output.js';
import { resolveServerDir } from '../services/server.js';
function parseServerProperties(serverPath) {
    const propsPath = join(serverPath, 'server.properties');
    if (!existsSync(propsPath))
        return {};
    const props = {};
    for (const line of readFileSync(propsPath, 'utf-8').split('\n')) {
        if (line.startsWith('#') || !line.includes('='))
            continue;
        const [k, ...v] = line.split('=');
        props[k.trim()] = v.join('=').trim();
    }
    return props;
}
function rconPacket(id, type, body) {
    const bodyBuf = Buffer.from(body + '\0\0', 'utf-8');
    const packet = Buffer.alloc(12 + bodyBuf.length);
    packet.writeInt32LE(8 + bodyBuf.length, 0);
    packet.writeInt32LE(id, 4);
    packet.writeInt32LE(type, 8);
    bodyBuf.copy(packet, 12);
    return packet;
}
function connectRcon(host, port, password) {
    return new Promise(resolve => {
        const socket = createConnection({ host, port }, () => socket.write(rconPacket(1, 3, password)));
        socket.once('data', data => {
            if (data.readInt32LE(4) === -1) {
                socket.destroy();
                resolve(null);
                return;
            }
            resolve({
                send: (cmd) => {
                    socket.write(rconPacket(2, 2, cmd));
                    socket.once('data', d => {
                        const resp = d.slice(12, d.length - 2).toString('utf-8');
                        if (resp)
                            process.stdout.write(resp + '\n');
                    });
                },
                close: () => socket.destroy(),
            });
        });
        socket.on('error', () => resolve(null));
        setTimeout(() => resolve(null), 3000);
    });
}
export const consoleCmd = defineCommand({
    meta: { description: 'Attach to server console via RCON' },
    args: {},
    async run() {
        intro(`💻 ${"Server console"}`);
        const serverPath = await resolveServerDir();
        if (!serverPath) {
            log.error("No server detected");
            process.exit(1);
        }
        const props = parseServerProperties(serverPath);
        const enabled = props['enable-rcon'] === 'true';
        const port = parseInt(props['rcon.port'] ?? '25575');
        const password = props['rcon.password'] ?? '';
        if (enabled && password) {
            log.step("Connecting via RCON...");
            const rcon = await connectRcon('127.0.0.1', port, password);
            if (rcon) {
                log.success("Connected — type commands (exit to quit)");
                const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
                rl.prompt();
                rl.on('line', line => {
                    const cmd = line.trim();
                    if (cmd === 'exit') {
                        rcon.close();
                        rl.close();
                        outro("Disconnected");
                        process.exit(0);
                    }
                    rcon.send(cmd);
                    rl.prompt();
                });
                rl.on('close', () => { rcon.close(); process.exit(0); });
                return;
            }
        }
        log.warn("RCON disabled in server.properties");
        log.info("Enable enable-rcon=true in server.properties");
        log.dim('enable-rcon=true');
        log.dim('rcon.port=25575');
        log.dim('rcon.password=your_password');
        process.exit(1);
    },
});
