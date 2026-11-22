import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The CLI's own version, read once from the package that ships it. */
export const VERSION: string = (() => {
    try {
        const here = dirname(fileURLToPath(import.meta.url)); // dist/infra
        const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf-8')) as {
            version?: string;
        };
        return pkg.version ?? '0.0.0';
    } catch {
        return '0.0.0';
    }
})();
