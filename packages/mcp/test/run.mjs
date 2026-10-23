// Runs every *.test.mjs in this folder in one process (portable: no shell globbing, Node 18 and later).
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
for (const f of readdirSync(here).filter((x) => x.endsWith(".test.mjs")).sort()) await import(pathToFileURL(join(here, f)).href);
