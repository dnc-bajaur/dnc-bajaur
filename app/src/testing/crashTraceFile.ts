import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** `app/var/` — gitignored, beside the server's own runtime files. */
export const TRACE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'var');
export const TRACE_FILE = join(TRACE_DIR, 'test-trace.log');
