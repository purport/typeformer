import { Project } from "ts-morph";

import { explicitify } from "./explicitify";
import { addSourceFilesToProject } from "./helpers";
import { stripNamespaces } from "./stripNamespaces";
import { unindent } from "./unindent";

type Step = {
    step: (project: Project) => void;
    // True if this step should run as part of the batch mode.
    batch: boolean;
};

const steps = new Map<string, Step>([
    ["noop", { step: () => {}, batch: false }], // To check diagnostics
    ["explicitify", { step: explicitify, batch: true }],
    ["unindent", { step: unindent, batch: true }],
    ["stripNamespaces", { step: stripNamespaces, batch: false }], // WIP
]);

const stepName = process.argv[2];

console.log("loading project");

const project = new Project({
    // Just for settings, we load the files below.
    tsConfigFilePath: "src/tsconfig-base.json",
    skipAddingFilesFromTsConfig: true,
});

addSourceFilesToProject(project);

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

    console.log(stepName);
    step.step(project);

    const diagnostics = project.getPreEmitDiagnostics();
    if (diagnostics.length > 0) {
        console.log(project.formatDiagnosticsWithColorAndContext(diagnostics));
        exitCode = 1;
        break;
    }
}

console.log("saving");
project.saveSync();

process.exit(exitCode);
