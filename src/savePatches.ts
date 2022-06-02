import { Command } from "clipanion";
import { $ } from "zx";

import { patchesDir } from "./utilities.js";

export class SavePatchesCommand extends Command {
    static paths = [["save-patches"]];

    static usage = Command.Usage({
        description: "Saves commits after the conversion steps back into the typeformer's patches.",
    });

    async execute() {
        await $`rm ${patchesDir}/*.patch`;
        await $`git format-patch -o ${patchesDir} --no-numbered --no-base --zero-commit HEAD^{"/CONVERSION STEP"}`;
    }
}
