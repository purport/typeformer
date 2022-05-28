import { Command, Option } from "clipanion";

export class MorphCommand extends Command {
    static paths = [["morph"]];

    static usage = Command.Usage({
        description: "Runs a specific transform.",
    });

    name = Option.String();

    async execute() {
        const morph = await import("./index.js");
        morph.runStep(this.name);
    }
}
