import { Project, ts } from "ts-morph";

import { explicitify } from "./explicitify.js";
import { formatImports } from "./formatImports.js";
import { inlineImports } from "./inlineImports.js";
import { stripModules } from "./stripModules.js";
// import { stripNamespaces } from "./stripNamespaces.js";
import { unindent } from "./unindent.js";
import { addTsSourceFiles, indentLog, log } from "./utilities.js";

type Step = (project: Project) => void;

const steps = new Map<string, Step>([
    ["noop", () => {}], // To check diagnostics
    ["unindent", unindent],
    ["explicitify", explicitify],
    //    ["stripNamespaces", stripNamespaces],
    ["stripModules", stripModules],
    ["inlineImports", inlineImports],
    ["formatImports", formatImports],
]);

export function runStep(stepName: string, check: boolean): number {
    const step = steps.get(stepName);
    if (!step) {
        console.error(`Unknown step ${stepName}`);
        return 1;
    }

    log("loading project");
    const project = new Project({
        // Just for settings; we load the files below.
        tsConfigFilePath: "tsconfig.json",
        skipAddingFilesFromTsConfig: true,
        manipulationSettings: {
            newLineKind: ts.NewLineKind.CarriageReturnLineFeed,
        },
    });

    addTsSourceFiles(project);

    log(stepName);
    indentLog(() => step(project));

    let exitCode = 0;

    if (check) {
        log("checking");
        const diagnostics = project.getPreEmitDiagnostics();
        if (diagnostics.length > 0) {
            if (diagnostics.length < 100) {
                console.error(project.formatDiagnosticsWithColorAndContext(diagnostics));
            } else {
                console.error("way too many diagnostics; open the repo instead");
            }
            exitCode = 1;
        }
    }

    log("saving");
    project.saveSync();
    return exitCode;
}
