'use strict';

/**
 * PowerNukkitX desktop app — servers on a VPS, over SSH.
 *
 * The model, decided once and kept everywhere:
 * - the server runs as a systemd service (`pnx-<slug>`), as a dedicated `pnx`
 *   system user, in /opt/pnx/<slug> unless the user picks another folder;
 *   Java 25 is a Temurin JRE in /opt/pnx/jre-25 so the distro's packages
 *   never matter;
 * - a folder the user picks must be new or empty, outside the system trees;
 *   it gets a `.pnx-assistant` marker, and uninstall deletes a folder outside
 *   /opt/pnx only when that marker is there;
 * - the console is a FIFO (`console.in`) the service keeps open on stdin, and a
 *   log (`console.log`) it writes stdout to: commands are a write, the live
 *   console is a `tail -F`;
 * - `stop` goes through ExecStop, which types `stop` and waits for the world to
 *   save; systemd restarts the server on a crash and starts it at boot;
 * - the SSH user is put in the `pnx` group and the service runs with UMask
 *   0002, so day-to-day work (config, plugins, backups) needs no root; a
 *   sudoers drop-in allows exactly start/stop/restart of that one unit.
 *
 * Root (or sudo) is needed once, to install. Credentials are stored encrypted
 * with Electron's safeStorage (the OS keychain), never in clear.
 */

const { createHash, randomBytes } = require('node:crypto');
const { readFileSync, existsSync } = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { join, basename } = require('node:path');

let ssh2 = null;
try {
    ssh2 = require('ssh2');
} catch {
    // optional at dev time; every call below answers 'ssh-missing'
}

const BASE = '/opt/pnx';
const JRE = `${BASE}/jre-25`;
const JAR = 'powernukkitx.jar';
const BACKUP_NAME = /^pnx-backup-[0-9T-]+$/;
const PLUGIN_FILE = /^[^\\/:*?"<>|'`$]+\.jar(\.disabled)?$/i;

/** single-quote a value for sh */
const q = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/** the key a remote server is known by everywhere (registry dir, events) */
function remoteKey({ user, host, port }, path) {
    return `ssh://${user}@${host}${Number(port) === 22 ? '' : `:${port}`}${path}`;
}

function fingerprint(key) {
    return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/** Trees a server folder may never live in: the system's own. */
const SYSTEM_TREES = ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/libx32', '/proc', '/root',
    '/run', '/sbin', '/snap', '/sys', '/tmp', '/usr', '/var/cache', '/var/lib', '/var/log', '/var/run', '/var/tmp',
    '/var/spool', '/lost+found'];

/**
 * A server folder as typed by the user, made safe or refused. Safe means:
 * absolute, at least two levels deep, plain characters only (the path goes
 * into a systemd unit and shell scripts), and outside the system trees.
 */
function cleanRemotePath(raw) {
    const path = String(raw || '').trim().replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
    if (!path) return { error: 'path-empty' };
    if (!path.startsWith('/')) return { error: 'path-relative' };
    if (!/^[A-Za-z0-9._\/-]+$/.test(path)) return { error: 'path-chars' };
    const parts = path.split('/').filter(Boolean);
    if (parts.some((part) => part === '.' || part === '..' || part.startsWith('-'))) return { error: 'path-chars' };
    if (parts.length < 2 || (parts[0] === 'home' && parts.length < 3)) return { error: 'path-shallow' };
    if (SYSTEM_TREES.some((tree) => path === tree || path.startsWith(`${tree}/`))) return { error: 'path-system' };
    if (path === BASE || path === JRE || path.startsWith(`${JRE}/`)) return { error: 'path-system' };
    return { path };
}

function slugify(name) {
    const slug = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
    return slug || 'server';
}

module.exports = function createRemote({ send, cliModules, launchArgs, safeStorage, errText }) {
    /* ── secrets ───────────────────────────────────────────────────────── */

    function seal(text) {
        if (!text) return null;
        if (!safeStorage?.isEncryptionAvailable()) throw new Error('no-keychain');
        return safeStorage.encryptString(String(text)).toString('base64');
    }
    function unseal(blob) {
        if (!blob) return null;
        try { return safeStorage.decryptString(Buffer.from(blob, 'base64')); } catch { return null; }
    }

    /* ── connections: one per server, kept alive, rebuilt on demand ─────── */

    const pool = new Map(); // key → { client, ready, conn }

    function connOf(entry) {
        const r = entry.remote;
        return {
            host: r.host,
            port: Number(r.port) || 22,
            user: r.user,
            auth: r.auth,
            keyPath: r.keyPath || null,
            password: r.auth === 'password' ? unseal(r.secret) : null,
            passphrase: r.auth === 'key' ? unseal(r.secret) : null,
            sudoPassword: r.auth === 'password' ? unseal(r.secret) : unseal(r.sudoSecret),
            hostKey: r.hostKey || null,
        };
    }

    function connect(conn, { onHostKey } = {}) {
        if (!ssh2) return Promise.reject(new Error('ssh-missing'));
        return new Promise((resolve, reject) => {
            const client = new ssh2.Client();
            let seen = null;
            let settled = false;
            const fail = (cause) => {
                if (settled) return;
                settled = true;
                try { client.end(); } catch { /* closed */ }
                reject(cause);
            };
            const options = {
                host: conn.host,
                port: conn.port || 22,
                username: conn.user,
                readyTimeout: 15000,
                keepaliveInterval: 15000,
                keepaliveCountMax: 4,
                tryKeyboard: Boolean(conn.password),
                hostVerifier: (key) => {
                    seen = fingerprint(key);
                    // trust on first use; a changed key afterwards is refused, never accepted silently
                    return !conn.hostKey || conn.hostKey === seen;
                },
            };
            if (conn.auth === 'key') {
                if (!conn.keyPath || !existsSync(conn.keyPath)) { fail(new Error('key-missing')); return; }
                try { options.privateKey = readFileSync(conn.keyPath); } catch { fail(new Error('key-missing')); return; }
                if (conn.passphrase) options.passphrase = conn.passphrase;
            } else {
                options.password = conn.password || '';
            }
            client.on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => {
                finish(prompts.map(() => conn.password || ''));
            });
            client.on('ready', () => {
                settled = true;
                onHostKey?.(seen);
                resolve({ client, fingerprint: seen });
            });
            client.on('error', (cause) => {
                if (conn.hostKey && seen && seen !== conn.hostKey) fail(new Error(`hostkey-changed:${seen}`));
                else if (/authentication methods failed|All configured authentication/i.test(cause.message)) fail(new Error('auth-failed'));
                else if (/Cannot parse privateKey|Encrypted private OpenSSH key|bad passphrase/i.test(cause.message)) fail(new Error('key-invalid'));
                else if (cause.level === 'client-timeout' || /Timed out/i.test(cause.message)) fail(new Error('timeout'));
                else fail(cause);
            });
            try {
                client.connect(options);
            } catch (cause) {
                fail(/privateKey|passphrase/i.test(cause.message) ? new Error('key-invalid') : cause);
            }
        });
    }

    async function clientFor(entry) {
        const key = entry.dir.toLowerCase();
        const hit = pool.get(key);
        if (hit) {
            try { return await hit.ready; } catch { pool.delete(key); }
        }
        const conn = connOf(entry);
        const ready = connect(conn).then(({ client }) => {
            client.on('close', () => {
                if (pool.get(key)?.ready === ready) pool.delete(key);
                stopTail(key);
            });
            return client;
        });
        pool.set(key, { ready });
        try {
            return await ready;
        } catch (cause) {
            pool.delete(key);
            throw cause;
        }
    }

    function close(entry) {
        const key = entry.dir.toLowerCase();
        stopTail(key);
        const hit = pool.get(key);
        pool.delete(key);
        hit?.ready.then((client) => client.end()).catch(() => {});
    }

    function closeAll() {
        for (const [key, hit] of pool) {
            stopTail(key);
            hit.ready.then((client) => client.end()).catch(() => {});
        }
        pool.clear();
    }

    /** runs one shell command; stdin optional; resolves with code, stdout, stderr */
    function exec(client, command, { stdin, onLine, timeoutMs = 120000 } = {}) {
        return new Promise((resolve, reject) => {
            client.exec(command, (cause, stream) => {
                if (cause) { reject(cause); return; }
                let out = '';
                let err = '';
                let carry = '';
                const timer = setTimeout(() => { try { stream.close(); } catch { /* gone */ } }, timeoutMs);
                stream.on('data', (chunk) => {
                    const text = chunk.toString('utf8');
                    out += text;
                    if (onLine) {
                        carry += text;
                        const lines = carry.split(/\r?\n/);
                        carry = lines.pop() || '';
                        for (const line of lines) onLine(line);
                    }
                });
                stream.stderr.on('data', (chunk) => { err += chunk.toString('utf8'); });
                stream.on('close', (code) => {
                    clearTimeout(timer);
                    if (onLine && carry) onLine(carry);
                    resolve({ code: code ?? -1, stdout: out, stderr: err });
                });
                if (stdin !== undefined) stream.end(stdin);
                else stream.end();
            });
        });
    }

    async function run(entry, command, opts) {
        const client = await clientFor(entry);
        return exec(client, command, opts);
    }

    /** a command that needs root: direct for root, sudo for the rest */
    function asRoot(conn, command, user) {
        if (user === 'root') return { command, stdin: undefined };
        if (conn.sudoPassword) return { command: `sudo -S -p '' ${command}`, stdin: `${conn.sudoPassword}\n` };
        return { command: `sudo -n ${command}`, stdin: undefined };
    }

    function sftpOf(client) {
        return new Promise((resolve, reject) => client.sftp((cause, sftp) => (cause ? reject(cause) : resolve(sftp))));
    }

    async function putFile(entry, localPath, remotePath) {
        const client = await clientFor(entry);
        const sftp = await sftpOf(client);
        try {
            await new Promise((resolve, reject) => sftp.fastPut(localPath, remotePath, (cause) => (cause ? reject(cause) : resolve())));
        } finally {
            sftp.end();
        }
    }

    async function putText(client, remotePath, text, mode = 0o664) {
        const sftp = await sftpOf(client);
        try {
            await new Promise((resolve, reject) => sftp.writeFile(remotePath, text, { mode }, (cause) => (cause ? reject(cause) : resolve())));
        } finally {
            sftp.end();
        }
    }

    const R = (entry) => entry.remote;
    const DIR = (entry) => R(entry).path;
    const UNIT = (entry) => R(entry).unit;

    /** files written over SSH must stay writable by the service */
    async function fixPerms(entry, target = DIR(entry)) {
        if (R(entry).user === 'root') {
            await run(entry, `chown -R pnx:pnx ${q(target)} && chmod -R g+rwX ${q(target)}`);
        } else {
            await run(entry, `find ${q(target)} -user "$(id -un)" -exec chmod g+rwX {} + 2>/dev/null; true`);
        }
    }

    /* ── probe: what the machine is, before anything is installed ──────── */

    const PROBE = [
        '. /etc/os-release 2>/dev/null',
        'echo "OS=${PRETTY_NAME:-$(uname -s)}"',
        'echo "ARCH=$(uname -m)"',
        'echo "UID=$(id -u)"',
        'echo "MEM=$(awk \'/MemTotal/{printf "%.0f", $2*1024}\' /proc/meminfo)"',
        'echo "CPUS=$(nproc 2>/dev/null || echo 1)"',
        'if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then echo SYSTEMD=1; else echo SYSTEMD=0; fi',
        'if [ "$(id -u)" = 0 ]; then echo SUDO=root; elif sudo -n true 2>/dev/null; then echo SUDO=nopass; elif command -v sudo >/dev/null 2>&1; then echo SUDO=pass; else echo SUDO=none; fi',
        'if command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; then echo FETCH=1; else echo FETCH=0; fi',
        `echo "JRE=$([ -x ${JRE}/bin/java ] && echo 1 || echo 0)"`,
        `echo "DISK=$(df -Pk ${BASE} 2>/dev/null | awk 'NR==2{printf "%.0f", $4*1024}' || df -Pk / | awk 'NR==2{printf "%.0f", $4*1024}')"`,
        `echo "SERVERS=$(ls -1d ${BASE}/*/ 2>/dev/null | grep -v jre- | wc -l)"`,
    ].join('; ');

    async function probe(conn) {
        const { client, fingerprint: fp } = await connect(conn);
        try {
            const res = await exec(client, PROBE, { timeoutMs: 20000 });
            const info = {};
            for (const line of res.stdout.split('\n')) {
                const at = line.indexOf('=');
                if (at > 0) info[line.slice(0, at)] = line.slice(at + 1).trim();
            }
            let sudo = info.SUDO;
            if (sudo === 'pass' && conn.sudoPassword) {
                const check = await exec(client, "sudo -S -p '' true", { stdin: `${conn.sudoPassword}\n`, timeoutMs: 15000 });
                sudo = check.code === 0 ? 'password' : 'refused';
            }
            return {
                fingerprint: fp,
                os: info.OS || '?',
                arch: info.ARCH || '?',
                root: info.UID === '0',
                totalMem: Number(info.MEM) || 0,
                cpus: Number(info.CPUS) || 1,
                systemd: info.SYSTEMD === '1',
                sudo, // root | nopass | password | pass (no password given) | refused | none
                fetch: info.FETCH === '1',
                jre: info.JRE === '1',
                disk: Number(info.DISK) || 0,
                servers: Number(info.SERVERS) || 0,
                supportedArch: /^(x86_64|amd64|aarch64|arm64)$/.test(info.ARCH || ''),
            };
        } finally {
            client.end();
        }
    }

    function canInstall(info) {
        if (!info.systemd) return 'no-systemd';
        if (!info.supportedArch) return 'arch';
        if (!['root', 'nopass', 'password'].includes(info.sudo)) return info.sudo === 'refused' ? 'sudo-refused' : 'no-sudo';
        return null;
    }

    /* ── provisioning: one script, run once as root ────────────────────── */

    function setupScript({ slug, user, url, jvmArgs, name, dir = null, unitBase = slug }) {
        return `#!/bin/bash
set -euo pipefail
export LC_ALL=C
BASE=${q(BASE)}
JRE=${q(JRE)}
SLUG=${q(slug)}
CUSTOM_DIR=${q(dir || '')}
UNIT_BASE=${q(unitBase)}
SSH_USER=${q(user)}
JAR_URL=${q(url)}
NAME=${q(name)}
step() { echo "::step $*"; }
fail() { echo "::fail $*"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
pkgs() {
  if have apt-get; then DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
  elif have dnf; then dnf install -y -q "$@"
  elif have yum; then yum install -y -q "$@"
  elif have zypper; then zypper -q -n install "$@"
  elif have apk; then apk add -q "$@"
  elif have pacman; then pacman -Sy --noconfirm "$@"
  else return 1; fi
}
fetch() { # url dest
  if have curl; then curl -fL --retry 3 --connect-timeout 20 -sS -o "$2" "$1"; else wget -q -O "$2" "$1"; fi
}

step system
have systemctl && [ -d /run/systemd/system ] || fail no-systemd
if [ -n "$CUSTOM_DIR" ]; then
  # checked before anything is downloaded or installed
  if [ -e "$CUSTOM_DIR" ] && [ ! -d "$CUSTOM_DIR" ]; then fail dir-file; fi
  if [ -d "$CUSTOM_DIR" ] && [ -n "$(ls -A "$CUSTOM_DIR" 2>/dev/null)" ]; then fail dir-not-empty; fi
fi
have curl || have wget || pkgs curl ca-certificates || fail no-fetch
have tar || pkgs tar || fail no-tar
have mkfifo || fail no-mkfifo

step java
case "$(uname -m)" in x86_64|amd64) ARCH=x64 ;; aarch64|arm64) ARCH=aarch64 ;; *) fail arch ;; esac
mkdir -p "$BASE"
if [ ! -x "$JRE/bin/java" ]; then
  TMP="$(mktemp -d)"
  fetch "https://api.adoptium.net/v3/binary/latest/25/ga/linux/$ARCH/jre/hotspot/normal/eclipse" "$TMP/jre.tgz" || fail jre-download
  mkdir -p "$TMP/jre"
  tar -xzf "$TMP/jre.tgz" -C "$TMP/jre" --strip-components=1
  rm -rf "$JRE"
  mv "$TMP/jre" "$JRE"
  rm -rf "$TMP"
fi
"$JRE/bin/java" -version 2>&1 | head -n 1

step user
if ! id pnx >/dev/null 2>&1; then
  useradd --system --home-dir "$BASE" --no-create-home --shell "$(command -v nologin || echo /bin/false)" pnx
fi
if [ "$SSH_USER" != root ]; then usermod -aG pnx "$SSH_USER"; fi

step files
if [ -n "$CUSTOM_DIR" ]; then
  DIR="$CUSTOM_DIR"
  UNIT="pnx-$UNIT_BASE"
else
  DIR="$BASE/$SLUG"
  if [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then DIR="$BASE/$SLUG-$(head -c 3 /dev/urandom | od -An -tx1 | tr -d ' \\n')"; fi
  UNIT="pnx-$(basename "$DIR")"
fi
if [ -e "/etc/systemd/system/$UNIT.service" ]; then UNIT="$UNIT-$(head -c 3 /dev/urandom | od -An -tx1 | tr -d ' \\n')"; fi
CREATED=0
[ -d "$DIR" ] || CREATED=1
mkdir -p "$DIR"
chown pnx:pnx "$DIR"
# the service user must reach the folder: a parent like a private /home/<user> would lock it out
if have runuser && ! runuser -u pnx -- test -w "$DIR"; then
  [ "$CREATED" = 1 ] && rmdir "$DIR" 2>/dev/null || true
  fail dir-locked
fi
echo "::dir $DIR"
echo "::unit $UNIT"
mkdir -p "$DIR/plugins" "$DIR/backups" "$DIR/logs"
echo "Created by the PowerNukkitX app - uninstalling from the app deletes this folder." > "$DIR/.pnx-assistant"
fetch "$JAR_URL" "$DIR/powernukkitx.jar.part" || fail jar-download
mv -f "$DIR/powernukkitx.jar.part" "$DIR/powernukkitx.jar"
cat > "$DIR/jvm.args" <<'ARGS'
${jvmArgs}
ARGS
cat > "$DIR/run.sh" <<'RUN'
#!/bin/sh
# started by systemd: the FIFO is the console's stdin, console.log its stdout
cd "$(dirname "$0")" || exit 1
[ -f console.log ] && mv -f console.log console.log.1
rm -f console.in
mkfifo -m 660 console.in
exec 3<>console.in
exec ${JRE}/bin/java $(cat jvm.args) -jar powernukkitx.jar --nogui <&3 >console.log 2>&1
RUN
chmod 755 "$DIR/run.sh"
chown -R pnx:pnx "$DIR"
chmod -R g+rwX "$DIR"
find "$DIR" -type d -exec chmod g+s {} +
chown root:root "$BASE" && chmod 755 "$BASE"

step service
cat > "/etc/systemd/system/$UNIT.service" <<UNITFILE
[Unit]
Description=PowerNukkitX - $NAME
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pnx
Group=pnx
UMask=0002
WorkingDirectory=$DIR
ExecStart=/bin/sh $DIR/run.sh
ExecStop=/bin/sh -c 'echo stop > $DIR/console.in; while kill -0 \\$MAINPID 2>/dev/null; do sleep 1; done'
TimeoutStopSec=90
Restart=on-failure
RestartSec=5
Environment=LANG=C.UTF-8

[Install]
WantedBy=multi-user.target
UNITFILE
if [ "$SSH_USER" != root ]; then
  SC="$(command -v systemctl)"
  printf '%s ALL=(root) NOPASSWD: %s start %s, %s stop %s, %s restart %s\\n' "$SSH_USER" "$SC" "$UNIT" "$SC" "$UNIT" "$SC" "$UNIT" > "/etc/sudoers.d/$UNIT"
  chmod 440 "/etc/sudoers.d/$UNIT"
  if have visudo; then visudo -cf "/etc/sudoers.d/$UNIT" >/dev/null || { rm -f "/etc/sudoers.d/$UNIT"; fail sudoers; }; fi
fi
systemctl daemon-reload
systemctl enable "$UNIT" >/dev/null 2>&1

step firewall
if have ufw && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 19132/udp >/dev/null && echo "::fw ufw"
elif have firewall-cmd && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port=19132/udp >/dev/null && firewall-cmd --reload >/dev/null && echo "::fw firewalld"
else
  echo "::fw none"
fi
echo "::done"
`;
    }

    function jvmArgsFor(server, memory) {
        return launchArgs(server, memory).filter((arg) => !['-jar', JAR, '--nogui'].includes(arg)).join(' ');
    }

    /**
     * Installs PowerNukkitX on the VPS. `form` holds the connection as typed
     * (clear secrets, never stored as such) and the server choices.
     */
    async function provision(form, log) {
        const conn = {
            host: String(form.host || '').trim(),
            port: Number(form.port) || 22,
            user: String(form.user || '').trim() || 'root',
            auth: form.auth === 'key' ? 'key' : 'password',
            keyPath: form.keyPath || null,
            password: form.auth === 'key' ? null : form.password || '',
            passphrase: form.auth === 'key' ? form.passphrase || null : null,
            sudoPassword: form.auth === 'key' ? form.sudoPassword || null : form.password || '',
            hostKey: form.hostKey || null,
        };
        if (!conn.host) return { ok: false, error: 'no-host' };

        log('remote.log.connect', [`${conn.user}@${conn.host}:${conn.port}`]);
        const info = await probe(conn);
        log('remote.log.fingerprint', [info.fingerprint], 'ok');
        log('remote.log.system', [info.os, info.arch, `${Math.round(info.totalMem / 1024 ** 3)} GB`], 'ok');
        const blocked = canInstall(info);
        if (blocked) return { ok: false, error: `remote-${blocked}` };

        const { release, server } = await cliModules();
        const releases = await release.listReleases();
        const wanted = releases.find((r) => r.tag === form.tag) ?? releases.find((r) => !r.prerelease) ?? releases[0];
        if (!wanted) return { ok: false, error: 'no-releases' };
        const asset = release.findAsset(wanted);
        if (!asset) return { ok: false, error: 'no-releases' };
        log('create.log.chosen', [wanted.tag], 'ok');

        const memory = form.memory || '2G';
        const slug = slugify(form.name);
        let custom = null;
        if (form.path) {
            const cleaned = cleanRemotePath(form.path);
            if (cleaned.error) return { ok: false, error: `remote-${cleaned.error}` };
            // the default folder keeps its own collision handling (a suffix)
            if (cleaned.path !== `${BASE}/${slug}`) custom = cleaned.path;
        }
        const script = setupScript({
            dir: custom,
            unitBase: custom ? slugify(basename(custom)) : slug,
            slug,
            user: conn.user,
            url: asset.url,
            jvmArgs: jvmArgsFor(server, memory),
            name: String(form.name || slug).replace(/[\r\n$`\\"]/g, ' ').slice(0, 48),
        });

        const { client } = await connect({ ...conn, hostKey: info.fingerprint });
        const steps = { system: 'remote.log.step.system', java: 'remote.log.step.java', user: 'remote.log.step.user', files: 'remote.log.step.files', service: 'remote.log.step.service', firewall: 'remote.log.step.firewall' };
        let dir = null;
        let unit = null;
        let firewall = 'none';
        let failure = null;
        try {
            const tmp = `/tmp/pnx-setup-${randomBytes(4).toString('hex')}.sh`;
            await putText(client, tmp, script, 0o700);
            const { command, stdin } = asRoot(conn, `bash ${tmp}`, conn.user);
            const res = await exec(client, `${command}; code=$?; rm -f ${tmp}; exit $code`, {
                stdin,
                timeoutMs: 15 * 60 * 1000,
                onLine: (line) => {
                    const m = line.match(/^::(\w+)\s*(.*)$/);
                    if (!m) {
                        if (line.trim()) send('create:log', { line: line.trim().slice(0, 300), kind: 'dim' });
                        return;
                    }
                    const [, kind, rest] = m;
                    if (kind === 'step') log(steps[rest] || 'remote.log.step.system');
                    else if (kind === 'dir') dir = rest.trim();
                    else if (kind === 'unit') unit = rest.trim();
                    else if (kind === 'fw') firewall = rest.trim();
                    else if (kind === 'fail') failure = rest.trim();
                },
            });
            if (res.code !== 0 || !dir || !unit) {
                const reason = failure || (/incorrect password|a password is required/i.test(res.stderr) ? 'sudo-refused' : 'script');
                if (res.stderr.trim()) send('create:log', { line: res.stderr.trim().split('\n').slice(-6).join(' | ').slice(0, 400), kind: 'error' });
                return { ok: false, error: `remote-${reason}` };
            }
        } finally {
            client.end();
        }
        log(firewall === 'none' ? 'remote.log.fwNone' : 'remote.log.fw', [firewall], firewall === 'none' ? 'warn' : 'ok');

        const remote = {
            host: conn.host,
            port: conn.port,
            user: conn.user,
            auth: conn.auth,
            keyPath: conn.auth === 'key' ? conn.keyPath : null,
            secret: seal(conn.auth === 'key' ? conn.passphrase : conn.password),
            sudoSecret: conn.auth === 'key' && conn.user !== 'root' ? seal(conn.sudoPassword) : null,
            hostKey: info.fingerprint,
            path: dir,
            unit,
            totalMem: info.totalMem,
            cpus: info.cpus,
            os: info.os,
        };
        return { ok: true, remote, dir: remoteKey(conn, dir), tag: wanted.tag, size: asset.size, memory, firewall };
    }

    /* ── status: systemd's view, plus "Done (" in this run's log ───────── */

    async function status(entry) {
        const res = await run(entry, [
            `systemctl show ${q(UNIT(entry))} -p ActiveState -p SubState -p MainPID -p ActiveEnterTimestampMonotonic -p Result -p UnitFileState`,
            `echo "DONE=$(grep -c 'Done (' ${q(`${DIR(entry)}/console.log`)} 2>/dev/null || echo 0)"`,
            'echo "UP=$(cut -d" " -f1 /proc/uptime)"',
            `echo "JAR=$([ -f ${q(`${DIR(entry)}/${JAR}`)} ] && echo 1 || echo 0)"`,
        ].join('; '), { timeoutMs: 15000 });
        const v = {};
        for (const line of res.stdout.split('\n')) {
            const at = line.indexOf('=');
            if (at > 0) v[line.slice(0, at)] = line.slice(at + 1).trim();
        }
        let state = 'stopped';
        if (v.ActiveState === 'active') state = Number(v.DONE) > 0 ? 'online' : 'starting';
        else if (v.ActiveState === 'activating' || v.ActiveState === 'reloading') state = 'starting';
        else if (v.ActiveState === 'deactivating') state = 'stopping';
        const mono = Number(v.ActiveEnterTimestampMonotonic) / 1e6;
        const up = Number(v.UP);
        const startedAt = state !== 'stopped' && mono > 0 && up > 0 ? Date.now() - (up - mono) * 1000 : null;
        return {
            state,
            pid: Number(v.MainPID) || null,
            startedAt,
            failed: v.ActiveState === 'failed' || (v.Result && v.Result !== 'success'),
            restarting: v.SubState === 'auto-restart',
            enabled: v.UnitFileState === 'enabled',
            installed: Boolean(v.ActiveState) && v.UnitFileState !== '',
            hasJar: v.JAR === '1',
        };
    }

    function systemctl(entry, verb) {
        const conn = connOf(entry);
        // the sudoers drop-in makes these three passwordless for this unit only
        const cmd = R(entry).user === 'root'
            ? `systemctl ${verb} ${q(UNIT(entry))}`
            : `sudo -n systemctl ${verb} ${UNIT(entry)}`;
        void conn;
        return run(entry, cmd, { timeoutMs: 120000 });
    }

    async function writeJvmArgs(entry, memory) {
        const { server } = await cliModules();
        const client = await clientFor(entry);
        await putText(client, `${DIR(entry)}/jvm.args`, `${jvmArgsFor(server, memory)}\n`);
    }

    async function start(entry, memory) {
        await writeJvmArgs(entry, memory).catch(() => {});
        const res = await systemctl(entry, 'start');
        if (res.code !== 0) return { ok: false, error: /password is required|not allowed/i.test(res.stderr) ? 'remote-sudo' : 'remote-start', message: res.stderr.trim() };
        startTail(entry);
        return { ok: true, memory, java: 'Temurin 25 (VPS)' };
    }

    async function stop(entry) {
        const res = await systemctl(entry, 'stop');
        if (res.code !== 0) return { ok: false, error: 'remote-stop', message: res.stderr.trim() };
        return { ok: true, graceful: true };
    }

    async function restart(entry, memory) {
        if (memory) await writeJvmArgs(entry, memory).catch(() => {});
        const res = await systemctl(entry, 'restart');
        if (res.code !== 0) return { ok: false, error: 'remote-start', message: res.stderr.trim() };
        startTail(entry);
        return { ok: true };
    }

    async function command(entry, text) {
        // `timeout`: with no reader on the FIFO a write would block forever
        const res = await run(entry, `timeout 3 sh -c 'printf "%s\\n" "$1" > "$2"' _ ${q(text)} ${q(`${DIR(entry)}/console.in`)}`, { timeoutMs: 10000 });
        return res.code === 0 ? { ok: true } : { ok: false, error: 'not-running' };
    }

    /* ── live console: tail -F on console.log ──────────────────────────── */

    const tails = new Map(); // key → { stream, client }
    const tailedOnce = new Set(); // after the first replay, a reconnect only follows new lines

    function stopTail(key) {
        const tail = tails.get(key);
        tails.delete(key);
        try { tail?.stream?.close(); } catch { /* gone */ }
    }

    async function startTail(entry) {
        const key = entry.dir.toLowerCase();
        if (tails.has(key)) return;
        tails.set(key, { stream: null });
        try {
            const client = await clientFor(entry);
            const backlog = tailedOnce.has(key) ? 0 : 400;
            tailedOnce.add(key);
            client.exec(`tail -n ${backlog} -F ${q(`${DIR(entry)}/console.log`)} 2>/dev/null`, (cause, stream) => {
                if (cause) { tails.delete(key); return; }
                if (!tails.has(key)) { stream.close(); return; }
                tails.set(key, { stream });
                let carry = '';
                stream.on('data', (chunk) => {
                    carry += chunk.toString('utf8');
                    const lines = carry.split(/\r?\n|\r/);
                    carry = lines.pop() || '';
                    if (lines.length) send('server:line', { dir: entry.dir, lines, stream: 'stdout' });
                });
                stream.on('close', () => { if (tails.get(key)?.stream === stream) tails.delete(key); });
            });
        } catch {
            tails.delete(key);
        }
    }

    /* ── files: config, plugins, backups, core ─────────────────────────── */

    async function readConfig(entry) {
        for (const name of ['pnx.yml', 'server.properties']) {
            const path = `${DIR(entry)}/${name}`;
            const res = await run(entry, `[ -f ${q(path)} ] && cat ${q(path)}`);
            if (res.code === 0) return { ok: true, which: name, path: `${R(entry).host}:${path}`, dir: entry.dir, text: res.stdout };
        }
        return { ok: true, which: 'pnx.yml', path: `${R(entry).host}:${DIR(entry)}/pnx.yml`, dir: entry.dir, text: '', exists: false };
    }

    async function writeConfig(entry, which, text) {
        const path = `${DIR(entry)}/${which}`;
        await run(entry, `[ -f ${q(path)} ] && cp -p ${q(path)} ${q(`${path}.assistant-bak`)}; true`);
        const client = await clientFor(entry);
        await putText(client, path, text.replace(/\r\n/g, '\n'));
        await fixPerms(entry, path).catch(() => {});
        return { ok: true, path };
    }

    async function listPlugins(entry) {
        const res = await run(entry, `cd ${q(`${DIR(entry)}/plugins`)} 2>/dev/null && for f in *.jar *.jar.disabled; do [ -f "$f" ] && printf '%s|%s\\n' "$(stat -c %s "$f")" "$f"; done; true`);
        return res.stdout.split('\n').filter(Boolean).map((line) => {
            const at = line.indexOf('|');
            return { fileName: line.slice(at + 1), size: Number(line.slice(0, at)) || 0 };
        }).filter((it) => PLUGIN_FILE.test(it.fileName));
    }

    async function installPlugin(entry, slug, onProgress) {
        const { plugins } = await cliModules();
        const tmp = await fsp.mkdtemp(join(os.tmpdir(), 'pnx-plugin-'));
        try {
            const old = (await plugins.getInstalled()).find((it) => it.slug === slug);
            const result = await plugins.installPlugin(slug, tmp, onProgress);
            const local = join(tmp, result.fileName);
            await putFile(entry, local, `${DIR(entry)}/plugins/${result.fileName}`);
            if (old && old.fileName !== result.fileName && PLUGIN_FILE.test(old.fileName)) {
                await run(entry, `rm -f ${q(`${DIR(entry)}/plugins/${old.fileName}`)} ${q(`${DIR(entry)}/plugins/${old.fileName}.disabled`)}`);
            }
            await fixPerms(entry, `${DIR(entry)}/plugins`).catch(() => {});
            return result;
        } finally {
            await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
        }
    }

    async function renamePlugin(entry, from, to) {
        if (!PLUGIN_FILE.test(from) || !PLUGIN_FILE.test(to)) throw new Error('invalid');
        const res = await run(entry, `mv -f ${q(`${DIR(entry)}/plugins/${from}`)} ${q(`${DIR(entry)}/plugins/${to}`)}`);
        if (res.code !== 0) throw new Error(res.stderr.trim() || 'mv');
    }

    async function removePlugin(entry, fileName) {
        if (!PLUGIN_FILE.test(fileName)) throw new Error('invalid');
        await run(entry, `rm -f ${q(`${DIR(entry)}/plugins/${fileName}`)}`);
    }

    const SKIP = ['backups', 'logs', 'cache', 'crash-reports', 'console.in', 'console.log', 'console.log.1'];

    async function backupList(entry) {
        const res = await run(entry, `cd ${q(`${DIR(entry)}/backups`)} 2>/dev/null && for d in pnx-backup-*; do [ -d "$d" ] && printf '%s|%s|%s|%s\\n' "$d" "$(du -sb "$d" | cut -f1)" "$(stat -c %Y "$d")" "$([ -f "$d/.auto" ] && echo 1 || echo 0)"; done; true`, { timeoutMs: 60000 });
        return res.stdout.split('\n').filter(Boolean).map((line) => {
            const [name, size, mtime, auto] = line.split('|');
            return { name, size: Number(size) || 0, date: new Date(Number(mtime) * 1000).toISOString(), auto: auto === '1' };
        }).filter((b) => BACKUP_NAME.test(b.name)).sort((a, b) => b.name.localeCompare(a.name));
    }

    async function backupCreate(entry, { auto = false } = {}) {
        const skip = SKIP.map((s) => `-e '^${s.replace(/\./g, '\\.')}$'`).join(' ');
        const script = `set -e; cd ${q(DIR(entry))}; n="pnx-backup-$(date -u +%Y-%m-%dT%H-%M-%S)"; mkdir -p "backups/$n"; `
            + `ls -A | grep -v ${skip} | grep -v '^\\.' | while IFS= read -r e; do cp -R --preserve=mode,timestamps "$e" "backups/$n/"; done; `
            + `${auto ? 'touch "backups/$n/.auto"; ' : ''}echo "NAME=$n"; echo "SIZE=$(du -sb "backups/$n" | cut -f1)"`;
        const res = await run(entry, script, { timeoutMs: 30 * 60 * 1000 });
        if (res.code !== 0) throw new Error(res.stderr.trim() || 'backup');
        const name = res.stdout.match(/NAME=(\S+)/)?.[1];
        const size = Number(res.stdout.match(/SIZE=(\d+)/)?.[1]) || 0;
        return { name, size };
    }

    async function backupRestore(entry, name) {
        if (!BACKUP_NAME.test(name)) throw new Error('invalid');
        const res = await run(entry, `set -e; cd ${q(DIR(entry))}; [ -d ${q(`backups/${name}`)} ]; for w in worlds world; do [ -d "backups/${name}/$w" ] && rm -rf "$w"; done; cp -R -f ${q(`backups/${name}`)}/. ./; rm -f .auto`, { timeoutMs: 30 * 60 * 1000 });
        if (res.code !== 0) throw new Error(res.stderr.trim() || 'restore');
        await fixPerms(entry).catch(() => {});
    }

    async function backupDelete(entry, name) {
        if (!BACKUP_NAME.test(name)) throw new Error('invalid');
        await run(entry, `rm -rf ${q(`${DIR(entry)}/backups/${name}`)}`, { timeoutMs: 120000 });
    }

    async function coreUpdate(entry, url) {
        const dir = DIR(entry);
        const res = await run(entry, `set -e; cd ${q(dir)}; `
            + `if command -v curl >/dev/null; then curl -fL --retry 3 -sS -o ${JAR}.part ${q(url)}; else wget -q -O ${JAR}.part ${q(url)}; fi; `
            + `cp -p ${JAR} ${JAR}.bak 2>/dev/null || true; mv -f ${JAR}.part ${JAR}`, { timeoutMs: 15 * 60 * 1000 });
        if (res.code !== 0) {
            await run(entry, `rm -f ${q(`${dir}/${JAR}.part`)}`).catch(() => {});
            throw new Error(res.stderr.trim() || 'download');
        }
        await fixPerms(entry, `${dir}/${JAR}`).catch(() => {});
    }

    async function sysinfo(entry) {
        const res = await run(entry, `awk '/MemTotal/{printf "%.0f\\n", $2*1024}' /proc/meminfo; nproc`, { timeoutMs: 15000 });
        const [mem, cpus] = res.stdout.trim().split('\n');
        return { totalMem: Number(mem) || R(entry).totalMem || 0, cpus: Number(cpus) || R(entry).cpus || 1, lan: [], host: R(entry).host, remote: true };
    }

    async function checkPort(entry, port) {
        const res = await run(entry, `(ss -Hlun 2>/dev/null || netstat -lun 2>/dev/null) | awk '{print $4 $5}' | grep -Eq ':${Number(port)}$' && echo BUSY || echo FREE`, { timeoutMs: 15000 });
        return { free: !/BUSY/.test(res.stdout) };
    }

    /** removes the service, its sudoers rule and its folder; the shared JRE stays */
    async function uninstall(entry, { sudoPassword } = {}) {
        const conn = connOf(entry);
        if (sudoPassword) conn.sudoPassword = sudoPassword;
        const unit = UNIT(entry);
        const dir = DIR(entry);
        const legacy = dir.startsWith(`${BASE}/`) && !dir.includes('..');
        if (!/^pnx-[a-z0-9-]+$/.test(unit) || (!legacy && cleanRemotePath(dir).path !== dir)) throw new Error('invalid');
        // outside /opt/pnx, a folder is deleted only if this app created it
        const removeDir = legacy
            ? `rm -rf ${q(dir)}`
            : `if [ -f ${q(`${dir}/.pnx-assistant`)} ]; then rm -rf ${q(dir)}; else echo KEPT; fi`;
        const script = `systemctl disable --now ${unit} >/dev/null 2>&1; rm -f /etc/systemd/system/${unit}.service /etc/sudoers.d/${unit}; systemctl daemon-reload; ${removeDir}; echo OK`;
        const { command, stdin } = asRoot(conn, `sh -c ${q(script)}`, R(entry).user);
        stopTail(entry.dir.toLowerCase());
        const res = await run(entry, command, { stdin, timeoutMs: 180000 });
        if (!/OK/.test(res.stdout)) throw new Error(/password/i.test(res.stderr) ? 'remote-sudo' : res.stderr.trim() || 'uninstall');
        const kept = /KEPT/.test(res.stdout);
        close(entry);
        return { kept };
    }

    /* ── choosing the folder: listing and checking before the install ─── */

    function formConn(form) {
        return {
            host: String(form.host || '').trim(),
            port: Number(form.port) || 22,
            user: String(form.user || '').trim() || 'root',
            auth: form.auth === 'key' ? 'key' : 'password',
            keyPath: form.keyPath || null,
            password: form.password || '',
            passphrase: form.passphrase || null,
            sudoPassword: form.auth === 'key' ? form.sudoPassword || null : form.password || '',
            hostKey: form.hostKey || null,
        };
    }

    // one connection reused while the user browses, closed after a minute idle
    let draft = null;
    async function draftClient(form) {
        const conn = formConn(form);
        const key = `${conn.user}@${conn.host}:${conn.port}|${conn.auth}|${conn.keyPath || ''}|${conn.hostKey || ''}`;
        if (draft && draft.key !== key) { draft.ready.then((c) => c.end()).catch(() => {}); draft = null; }
        if (!draft) {
            const ready = connect(conn).then(({ client }) => {
                client.on('close', () => { if (draft?.ready === ready) draft = null; });
                return client;
            });
            draft = { key, ready, timer: null };
            ready.catch(() => { if (draft?.ready === ready) draft = null; });
        }
        clearTimeout(draft.timer);
        const current = draft;
        current.timer = setTimeout(() => {
            current.ready.then((c) => c.end()).catch(() => {});
            if (draft === current) draft = null;
        }, 60000);
        return current.ready;
    }

    /** Subfolders of `path` (or of its nearest existing parent), as the SSH user sees them. */
    async function browse(form, path) {
        const client = await draftClient(form);
        const start = String(path || '').startsWith('/') && !/[\0\n]/.test(path) ? path : '/';
        const res = await exec(client, [
            `p=${q(start)}`,
            'while [ ! -d "$p" ] && [ "$p" != / ]; do p=$(dirname "$p"); done',
            'cd -- "$p" 2>/dev/null || cd /',
            'echo "PWD=$(pwd)"',
            "find . -mindepth 1 -maxdepth 1 -type d ! -name '.*' 2>/dev/null | sed 's|^\\./||' | LC_ALL=C sort | head -n 300",
        ].join('; '), { timeoutMs: 20000 });
        const lines = res.stdout.split('\n').map((line) => line.trimEnd()).filter(Boolean);
        const pwd = (lines.find((line) => line.startsWith('PWD=')) || 'PWD=/').slice(4);
        return { path: pwd, dirs: lines.filter((line) => !line.startsWith('PWD=')) };
    }

    /** Whether a folder can take a new server: new, or empty, and allowed. */
    async function checkPath(form, path) {
        const cleaned = cleanRemotePath(path);
        if (cleaned.error) return { ok: false, error: cleaned.error };
        const client = await draftClient(form);
        const p = q(cleaned.path);
        const res = await exec(client, [
            `if [ -d ${p} ]; then if ! ls -A ${p} >/dev/null 2>&1; then echo LOCKED; elif [ -z "$(ls -A ${p})" ]; then echo EMPTY; else echo FULL; fi; elif [ -e ${p} ]; then echo FILE; else echo NEW; fi`,
            // the service user is neither the owner nor (usually) in the group of a parent:
            // a parent without "others may enter" (a private home) locks it out
            `d=${p}; while [ "$d" != / ]; do d=$(dirname "$d"); if [ -d "$d" ]; then case "$(stat -c %A "$d" 2>/dev/null)" in ?????????[xt]) ;; *) echo PRIVATE; break ;; esac; fi; done`,
        ].join('; '), { timeoutMs: 15000 });
        let state = (res.stdout.match(/LOCKED|EMPTY|FULL|FILE|NEW/) || ['NEW'])[0].toLowerCase();
        if (/PRIVATE/.test(res.stdout) && (state === 'new' || state === 'empty' || state === 'locked')) state = 'private';
        return { ok: state === 'new' || state === 'empty' || state === 'locked', path: cleaned.path, state };
    }

    return {
        available: () => Boolean(ssh2),
        browse,
        checkPath,
        cleanRemotePath,
        defaultPath: (name) => `${BASE}/${slugify(name)}`,
        probe: async (form) => {
            const conn = {
                host: String(form.host || '').trim(),
                port: Number(form.port) || 22,
                user: String(form.user || '').trim() || 'root',
                auth: form.auth === 'key' ? 'key' : 'password',
                keyPath: form.keyPath || null,
                password: form.password || '',
                passphrase: form.passphrase || null,
                sudoPassword: form.auth === 'key' ? form.sudoPassword || null : form.password || '',
                hostKey: form.hostKey || null,
            };
            const info = await probe(conn);
            return { ...info, blocked: canInstall(info) };
        },
        provision,
        status,
        start,
        stop,
        restart,
        command,
        startTail,
        stopTail: (entry) => stopTail(entry.dir.toLowerCase()),
        readConfig,
        writeConfig,
        listPlugins,
        installPlugin,
        renamePlugin,
        removePlugin,
        backupList,
        backupCreate,
        backupRestore,
        backupDelete,
        coreUpdate,
        sysinfo,
        checkPort,
        uninstall,
        close,
        closeAll,
        errText,
        remoteKey,
        // exported for tests
        _setupScript: setupScript,
        _slugify: slugify,
        _cleanRemotePath: cleanRemotePath,
    };
};
