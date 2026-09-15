/** Copies the static control-surface assets into dist (build step). */
import { cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const from = fileURLToPath(new URL('../src/ui/public/', import.meta.url));
const to = fileURLToPath(new URL('../dist/src/ui/public/', import.meta.url));
cpSync(from, to, { recursive: true });
console.log(`ui assets → ${to}`);
