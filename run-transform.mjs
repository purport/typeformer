#!/usr/bin/env node
//@ts-check

import assert from "assert";
import { readFileSync } from "fs";
import * as path from "path";
import { performance } from "perf_hooks";
import prettyMs from "pretty-ms";
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
 * @param {string} s
 */
function reformatParagraphs(s) {
    return s
        .split(/\r?\n\r?\n/)
        .map((paragraph) =>
            paragraph
                .split(/\r?\n/)
                .map((line) => line.trim())
                .join(" ")
                .trim()
        )
        .join("\n\n")
        .trim();
}

/**
 * @param {string} message
 * @param {() => Promise<any>} fn
 */
async function runAndCommit(message, fn) {
    await fn();
    await $`git add . && git commit --quiet -m ${reformatParagraphs(message)}`;
}

const morphPath = path.join(__dirname, "dist", "morph", "cli.js");

/**
 * @param {string} name
 * @param {string} description
 */
async function runMorph(name, description) {
    await runAndCommit(`CONVERSION STEP - ${name}\n\n${description}`, async () => {
        const before = performance.now();
        await $`node ${morphPath} ${name}`;
        console.log(`took ${prettyMs(performance.now() - before)}`);
    });
}

async function noopStep() {
    await $`node ${morphPath} noop`;
}

async function applyPatches() {
    // Regenerate patches by removing the patches dir then running:
    //     rm ~/work/typeformer/patches2/*
    //     git format-patch -o ~/work/typeformer/patches2 --no-numbered --no-base --zero-commit HEAD^{"/CONVERSION STEP"}
    // TODO: Move patches2 to patches.
    await $`git am --3way --whitespace=nowarn --quoted-cr=nowarn --keep-cr ${__dirname}/patches2/*.patch`;
}

// This totally wipes the repo and starts from scratch.
await $`git clean -fd && git restore . && git reset --hard $(git merge-base HEAD main)`;

await generateDiagnostics();

await runAndCommit(
    `Undo webworker change

This change causes problems for project loading
(even though it really shouldn't); revert it for now.
`,
    async () => {
        await $`git revert --no-edit 55e2e15aa37e685b7adcc61dd3091a2d9c7773a1 && git reset HEAD^`;
    }
);

await runMorph(
    "unindent",
    `
This step makes further commits look clearer by unindenting all
of the top level namespaces preemptively.
`
);

await runMorph(
    "explicitify",
    `
This step makes all implicit namespace accesses explicit, e.g. "Node" turns into
"ts.Node".
`
);

await runMorph(
    "stripNamespaces",
    `
This step converts each file into an exported module by hoisting the namespace
bodies into the global scope and transferring internal markers down onto declarations
as needed.

The namespaces are reconstructed as "barrel"-style modules, which are identical
to the old namespace objects in structure. These reconstructed namespaces are then
imported in the newly module-ified files, making existing expressions like "ts." valid.
`
);

await runMorph(
    "inlineImports",
    `
This step converts as many explicit accesses as possible in favor of direct imports
from the modules in which things were declared. This restores the code (as much as possible)
back to how it looked originally before the explicitify step, e.g. instead of "ts.Node"
and "ts.Symbol", we have just "Node" and "Symbol".
`
);

await applyPatches();

// Make sure what we get back from our new diagnostics script still compiles.
await generateDiagnostics();
await noopStep();
