import { performance } from "perf_hooks";
import { Project, ts } from "ts-morph";

import { explicitify } from "./explicitify";
import { addSourceFilesToProject } from "./helpers";
import { stripNamespaces } from "./stripNamespaces";
import { unindent } from "./unindent";

function timeIt<T>(fn: () => T): T {
    const before = performance.now();
    try {
        return fn();
    } finally {
        const took = (performance.now() - before) / 1000;
        console.log(`\ttook ${took.toFixed(2)}s`);
    }
}

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
]);

const stepName = process.argv[2];

const project = timeIt(() => {
    console.log("loading project");
    const project = new Project({
        // Just for settings; we load the files below.
        tsConfigFilePath: "src/tsconfig-base.json",
        skipAddingFilesFromTsConfig: true,
        manipulationSettings: {
            newLineKind: ts.NewLineKind.CarriageReturnLineFeed,
        },
    });

    addSourceFilesToProject(project);
    return project;
});

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

    timeIt(() => {
        console.log(stepName);
        step.step(project);
    });

    exitCode = timeIt((): number => {
        console.log("checking");
        const diagnostics = project.getPreEmitDiagnostics();
        if (diagnostics.length > 0) {
            if (diagnostics.length < 100) {
                console.error(project.formatDiagnosticsWithColorAndContext(diagnostics));
            } else {
                console.error("way too many diagnostics; open the repo instead");
            }
            return 1;
        }
        return 0;
    });

    if (exitCode) {
        break;
    }
}

timeIt(() => {
    console.log("saving");
    project.saveSync();
});

process.exit(exitCode);
