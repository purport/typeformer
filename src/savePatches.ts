import { Command } from "clipanion";
import { globbySync } from "globby";

import { runWithOutput as run } from "./exec.js";
import { patchesDir } from "./utilities.js";

export class SavePatchesCommand extends Command {
    static paths = [["save-patches"]];

    static usage = Command.Usage({
        description: "Saves commits after the conversion steps back into the typeformer's patches.",
    });

    async execute() {
        const patches = globbySync(`${patchesDir}/*.patch`);
        if (patches.length > 0) {
            await run("rm", ...patches);
        }

        await run(
            "git",
            "format-patch",
            "-o",
            patchesDir,
            "--no-numbered",
            "--no-base",
            "--zero-commit",
            "HEAD^{/CONVERSION STEP}"
        );
    }
}
