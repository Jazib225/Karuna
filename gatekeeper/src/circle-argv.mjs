// Runs the Circle CLI's JS entry with arguments read from a JSON file.
// Used on Windows, where a contract's bytecode overflows the ~32K command-line limit.
// Usage: node circle-argv.mjs <cli entry .js> <args.json>
import { readFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [, , bin, argsFile] = process.argv;
const args = JSON.parse(readFileSync(argsFile, "utf8"));
rmSync(argsFile, { force: true });
process.argv = [process.argv[0], bin, ...args];
await import(pathToFileURL(bin).href);
