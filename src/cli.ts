import assert from "assert";
import { Builtins, Cli } from "clipanion";
import { readFileSync } from "fs";

import { CreateStackCommand } from "./createStack.js";
import { MorphCommand } from "./morph/cli.js";
import { RunTransformCommand } from "./runTransform.js";

// Ensure we're in the typescript repo.
const packageJson = readFileSync("package.json", { encoding: "utf-8" });
assert(JSON.parse(packageJson).name === "typescript");

const cli = new Cli({
    binaryName: "typeformer",
    enableCapture: true,
});

cli.register(Builtins.HelpCommand);
cli.register(RunTransformCommand);
cli.register(MorphCommand);
cli.register(CreateStackCommand);

cli.runExit(process.argv.slice(2));
