import { rmSync } from 'node:fs';

// dist is regenerated wholesale on every build: stale files from a previous
// shape of the source tree are how a `pnx` command breaks only on machines
// that rebuilt last
rmSync('dist', { recursive: true, force: true });
