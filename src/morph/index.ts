import { Project, ts } from "ts-morph";

import { explicitify } from "./explicitify";
import { inlineImports } from "./inlineImports";
import { stripNamespaces } from "./stripNamespaces";
import { unindent } from "./unindent";
import { addTsSourceFiles, indentLog, log } from "./utilities";

type Step = {
    step: (project: Project) => void;
    // True if this step should run as part of the batch mode.
    batch: boolean;
};

const steps = new Map<string, Step>([
    ["noop", { step: () => {}, batch: false }], // To check diagnostics
    ["unindent", { step: unindent, batch: true }],
    ["explicitify", { step: explicitify, batch: true }],
    ["stripNamespaces", { step: stripNamespaces, batch: true }], // WIP
    ["inlineImports", { step: inlineImports, batch: true }], // WIP
]);

const stepName = process.argv[2];

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

let stepsToRun: Iterable<[name: string, step: Step]>;

let batch: boolean;
if (stepName) {
    const step = steps.get(stepName);
    if (!step) {
        console.error(`Unknown step ${stepName}`);
        process.exit(1);
    }
    stepsToRun = [[stepName, step]];
    batch = false;
} else {
    stepsToRun = steps.entries();
    batch = true;
}

let exitCode = 0;

for (const [stepName, step] of stepsToRun) {
    if (batch && !step.batch) {
        continue;
    }

    log(stepName);
    indentLog(() => step.step(project));

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

    if (exitCode) {
        break;
    }
}

log("saving");
project.saveSync();

process.exit(exitCode);
