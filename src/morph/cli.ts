import { Command, Option } from "clipanion";

export class MorphCommand extends Command {
    static paths = [["morph"]];

    static usage = Command.Usage({
        description: "Runs a specific transform.",
    });

    name = Option.String();

    async execute() {
        // Do this lazily to avoid loading all of TS for every invocation of the tool.
        const morph = await import("./index.js");
        return morph.runStep(this.name);
    }
}
