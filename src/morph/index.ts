import { Project, ts } from "ts-morph";

import { explicitify } from "./explicitify.js";
import { formatImports } from "./formatImports.js";
import { inlineImports } from "./inlineImports.js";
import { stripNamespaces } from "./stripNamespaces.js";
import { unindent } from "./unindent.js";
import { addTsSourceFiles, indentLog, log } from "./utilities.js";

type Step = (project: Project) => void;

const steps = new Map<string, Step>([
    ["noop", () => {}], // To check diagnostics
    ["unindent", unindent],
    ["explicitify", explicitify],
    ["stripNamespaces", stripNamespaces],
    ["inlineImports", inlineImports],
    ["formatImports", formatImports],
]);

export function runStep(stepName: string): number {
    const step = steps.get(stepName);
    if (!step) {
        console.error(`Unknown step ${stepName}`);
        return 1;
    }

    log("loading project");
    const project = new Project({
        // Just for settings; we load the files below.
        tsConfigFilePath: "src/tsconfig-base.json",
        skipAddingFilesFromTsConfig: true,
        manipulationSettings: {
            newLineKind: ts.NewLineKind.CarriageReturnLineFeed,
        },
    });

    addTsSourceFiles(project);

    log(stepName);
    indentLog(() => step(project));

    log("checking");
    const diagnostics = project.getPreEmitDiagnostics();
    if (diagnostics.length > 0) {
        if (diagnostics.length < 100) {
            console.error(project.formatDiagnosticsWithColorAndContext(diagnostics));
        } else {
            console.error("way too many diagnostics; open the repo instead");
        }
        return 1;
    }

    log("saving");
    project.saveSync();
    return 0;
}
