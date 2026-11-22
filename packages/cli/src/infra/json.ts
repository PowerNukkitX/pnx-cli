/**
 * `--json` mode: where commands ask whether to answer as data, and where they
 * emit the answer when the flag is on.
 */

let jsonMode = process.argv.includes('--json');

function isJson(): boolean {
    return jsonMode;
}

/** Flips mode when a command needs to know explicitly. */
export function setJsonMode(enabled: boolean): void {
    jsonMode = enabled;
}

/** Emits one JSON document. The whole output a `--json` run should print. */
function emit(payload: unknown): void {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

export const json = { isJson, setJsonMode, emit } as const;
