import { defineCommand } from 'citty';
export const pluginCmd = defineCommand({
    meta: { description: 'Plugin management' },
    subCommands: {
        install: () => import('./install.js').then(m => m.installCmd),
        list: () => import('./list.js').then(m => m.listCmd),
        search: () => import('./search.js').then(m => m.searchCmd),
        info: () => import('./info.js').then(m => m.infoCmd),
        update: () => import('./update.js').then(m => m.updateCmd),
        remove: () => import('./remove.js').then(m => m.removeCmd),
        installed: () => import('./installed.js').then(m => m.installedCmd),
    },
});
