import { Command, Option } from "clipanion";
import { globby } from "globby";

import { getMergeBase, runWithOutput as run } from "./exec.js";
import { afterPatchesDir, beforePatchesDir } from "./utilities.js";

export class SavePatchesCommand extends Command {
    static paths = [["save-patches"]];

    before = Option.Boolean(`--before`);
    after = Option.Boolean(`--after`);

    static usage = Command.Usage({
        description: "Saves commits after the Generated module conversion steps back into the typeformer's patches.",
    });

    async execute() {
        if (!this.before && !this.after) {
            throw new Error("Must provide --before and/or --after.");
        }

        if (this.before) {
            const mergeBase = await getMergeBase(run);

            const beforePatches = await globby(`${beforePatchesDir}/*.patch`);
            if (beforePatches.length > 0) {
                await run("rm", ...beforePatches);
            }

            await run(
                "git",
                "format-patch",
                "-o",
                beforePatchesDir,
                "--no-numbered",
                "--no-base",
                "--zero-commit",
                `${mergeBase}..:/!-Generated module conversion step`
            );
        }

        if (this.after) {
            const afterPatches = await globby(`${afterPatchesDir}/*.patch`);
            if (afterPatches.length > 0) {
                await run("rm", ...afterPatches);
            }

            await run(
                "git",
                "format-patch",
                "-o",
                afterPatchesDir,
                "--no-numbered",
                "--no-base",
                "--zero-commit",
                "HEAD^{/Generated module conversion step}"
            );
        }
    }
}
