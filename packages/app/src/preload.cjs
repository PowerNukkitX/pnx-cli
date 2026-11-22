'use strict';

/**
 * The renderer's whole view of the world: a handful of channels and events,
 * name-checked here so a typo dies at the bridge instead of in the void.
 */

const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = [
    'app:about',
    'app:theme',
    'app:openStateFolder',
    'dialog:pickFolder',
    'fs:validateDir',
    'fs:suggestDir',
    'releases:list',
    'java:check',
    'system:info',
    'net:checkPort',
    'server:create',
    'server:start',
    'server:stop',
    'server:restart',
    'server:status',
    'server:command',
    'server:default',
    'core:update',
    'backup:list',
    'backup:create',
    'backup:restore',
    'backup:delete',
    'logs:export',
    'state:get',
    'state:set',
    'state:reset',
    'servers:list',
    'servers:add',
    'servers:activate',
    'servers:rename',
    'servers:setMemory',
    'servers:remove',
    'servers:states',
    'servers:setSchedule',
    'remote:probe',
    'remote:create',
    'remote:uninstall',
    'remote:browse',
    'remote:checkPath',
    'dialog:pickFile',
    'plugins:search',
    'plugins:detail',
    'plugins:installed',
    'plugins:updates',
    'plugins:install',
    'plugins:toggle',
    'plugins:remove',
    'config:read',
    'config:write',
    'update:check',
    'update:download',
    'update:install',
    'shell:openFolder',
    'shell:openFile',
    'shell:openExternal',
];

const EVENTS = [
    'create:log',
    'create:progress',
    'core:progress',
    'server:line',
    'server:state',
    'server:exit',
    'plugin:progress',
    'update:event',
    'backup:event',
];

contextBridge.exposeInMainWorld('pnx', {
    invoke: (channel, payload) => {
        if (!INVOKE.includes(channel)) return Promise.reject(new Error(`channel refused: ${channel}`));
        return ipcRenderer.invoke(channel, payload);
    },
    on: (event, listener) => {
        if (!EVENTS.includes(event)) throw new Error(`event refused: ${event}`);
        const wrapped = (_ignore, payload) => listener(payload);
        ipcRenderer.on(event, wrapped);
        return () => ipcRenderer.removeListener(event, wrapped);
    },
    platform: process.platform,
});
