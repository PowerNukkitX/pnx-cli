import { intro, outro, log } from '../ui/output.js';
import { promptSelect, promptText } from '../ui/prompts.js';
import { resolveServerDir } from '../services/server.js';
import { loadPid, isAlive } from '../services/process.js';
import { c } from '../ui/theme.js';
export async function runMenu() {
    while (true) {
        const done = await menuStep();
        if (done)
            return;
        await promptText({ message: "Press enter to return to the menu", placeholder: '' });
    }
}
async function menuStep() {
    const serverPath = await resolveServerDir();
    const hasServer = serverPath !== null;
    const pid = await loadPid();
    const running = pid !== null && isAlive(pid.pid);
    intro(c.green(`⚡ ${"PowerNukkitX Menu"}`));
    if (running)
        log.info(`Server running (PID ${String(pid.pid)})`);
    else if (hasServer)
        log.info("Server stopped");
    else
        log.warn("No server detected");
    const options = [];
    if (!hasServer)
        options.push({ value: 'create', label: "Create a server" });
    if (hasServer && !running)
        options.push({ value: 'start', label: "Start the server" });
    if (running)
        options.push({ value: 'stop', label: "Stop the server" });
    if (hasServer) {
        options.push({ value: 'plugins', label: "Manage plugins" });
        options.push({ value: 'install', label: "Install a plugin" });
        options.push({ value: 'update', label: "Update the core" });
        options.push({ value: 'backup', label: "Backup" });
    }
    options.push({ value: 'doctor', label: "Diagnostics" });
    options.push({ value: 'info', label: "Information" });
    options.push({ value: 'quit', label: "Quit" });
    const choice = await promptSelect("What do you want to do?", options);
    switch (choice) {
        case 'create': {
            const { initCmd } = await import('./init.js');
            await initCmd.run({ args: {} });
            break;
        }
        case 'start': {
            const { runStart } = await import('./start.js');
            await runStart({});
            break;
        }
        case 'stop': {
            const { runStop } = await import('./stop.js');
            await runStop();
            break;
        }
        case 'plugins': {
            const { installCmd } = await import('./plugin/install.js');
            await installCmd.run({ args: {} });
            break;
        }
        case 'install': {
            const { runInstall } = await import('./install.js');
            await runInstall();
            break;
        }
        case 'update': {
            const { runUpdate } = await import('./update.js');
            await runUpdate();
            break;
        }
        case 'backup': {
            const { runBackup } = await import('./backup.js');
            await runBackup();
            break;
        }
        case 'doctor': {
            const { doctorCmd } = await import('./doctor.js');
            await doctorCmd.run({ args: {} });
            break;
        }
        case 'info': {
            const { infoCmd } = await import('./info.js');
            await infoCmd.run({ args: {} });
            break;
        }
        case 'quit':
            outro("See you soon!");
            return true;
    }
    return false;
}
