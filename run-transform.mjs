//@ts-check

import assert from "assert";
import { readFileSync } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { $, os } from "zx";

if (os.platform() === "win32") {
    throw new Error("This script doesn't work on Windows, sorry.");
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure we're in the typescript repo.
const packageJson = readFileSync("package.json", { encoding: "utf-8" });
assert(JSON.parse(packageJson).name === "typescript");

async function generateDiagnostics() {
    await $`rm -f src/compiler/diagnosticInformationMap.generated.ts`;
    await $`npx gulp generate-diagnostics`;
}

/**
 * @param {string} message
 * @param {() => Promise<any>} fn
 */
async function runAndCommit(message, fn) {
    await fn();
    await $`git add . && git commit -m ${message}`;
}

/**
 * @param {string} name
 */
async function runMorph(name) {
    await runAndCommit(`CONVERSION STEP - ${name}`, async () => {
        await $`node ${path.join(__dirname, "lib", "morph")} ${name}`;
    });
}

async function applyPatches() {
    await $`git am --3way --whitespace=nowarn --quoted-cr=nowarn --keep-cr ${__dirname}/patches/*.patch`;
}

// This totally wipes the repo and starts from scratch.
await $`git clean -fd && git restore . && git reset --hard $(git merge-base HEAD main)`;

await generateDiagnostics();

await runMorph("unindent");
await runMorph("explicitify");
await runMorph("stripNamespaces");

// await applyPatches();
