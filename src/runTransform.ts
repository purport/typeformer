import { Command, Option } from "clipanion";
import { globbySync } from "globby";
import { performance } from "perf_hooks";
import prettyMs from "pretty-ms";

import { getMergeBase, runNode, runWithOutput as run } from "./exec.js";
import { packageRoot, patchesDir } from "./utilities.js";

export class RunTransformCommand extends Command {
    static paths = [["run"], ["run-transform"]];

    static usage = Command.Usage({
        description: "Runs all transforms and applies fixup patches.",
    });

    reset = Option.Boolean("--reset", true, {
        description: "Reset the current branch to its merge base with main before running.",
    });

    async execute() {
        if (this.reset) {
            await run("git", "restore", "--staged", "."); // Unstage all changes.
            await run("git", "restore", "."); // Undoo all changes.
            await run("git", "clean", "-fd"); // Remove any potentially new files.
            const mergeBase = await getMergeBase(run);
            await run("git", "reset", "--hard", mergeBase); // Reset back to the merge base.
        }

        await generateDiagnostics();

        await runAndCommit(
            `Undo webworker change

This change causes problems for project loading
(even though it really shouldn't); revert it for now.
`,
            async () => {
                await run("git", "revert", "--no-edit", "55e2e15aa37e685b7adcc61dd3091a2d9c7773a1");
                await run("git", "reset", "HEAD^");
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
    }
}

async function generateDiagnostics() {
    await run("rm", "-f", "src/compiler/diagnosticInformationMap.generated.ts");
    await run("npx", "gulp", "generate-diagnostics");
}

function reformatParagraphs(s: string) {
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

async function runAndCommit(message: string, fn: () => Promise<any>) {
    await fn();
    await run("git", "add", ".");
    await run("git", "commit", "--quiet", "-m", reformatParagraphs(message));
}

async function runMorph(name: string, description: string) {
    await runAndCommit(`CONVERSION STEP - ${name}\n\n${description}`, async () => {
        const before = performance.now();
        await runNode(packageRoot, "morph", name);
        console.log(`took ${prettyMs(performance.now() - before)}`);
    });
}

async function noopStep() {
    await runNode(packageRoot, "morph", "noop");
}

async function applyPatches() {
    // Regenerate patches by running `save-patches`.
    await run(
        "git",
        "am",
        "--3way",
        "--whitespace=nowarn",
        "--quoted-cr=nowarn",
        "--keep-cr",
        ...globbySync(`${patchesDir}/*.patch`) // git am doesn't accept a regular directory, only a "Maildir" (which is something different)
    );
}
