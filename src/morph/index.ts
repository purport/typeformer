import { Project, SourceFile } from "ts-morph";

import { explicitify } from "./explicitify";
import { unindent } from "./unindent";

type Step = (sourceFile: SourceFile) => void;

const steps = new Map<string, Step>([
    ["explicitify", explicitify],
    ["unindent", unindent],
]);

const stepName = process.argv[2];

console.log("loading project");

const project = new Project({
    tsConfigFilePath: "src/tsconfig-base.json",
    skipAddingFilesFromTsConfig: true,
    // useInMemoryFileSystem: true,
});

const sourceFileGlobs = ["src/**/*.ts", "!**/*.d.ts"];

project.addSourceFilesAtPaths(sourceFileGlobs);

let stepsToRun: Iterable<[name: string, step: Step]>;

if (stepName) {
    const step = steps.get(stepName);
    if (!step) {
        console.error(`Unknown step ${stepName}`);
        process.exit(1);
    }
    stepsToRun = [[stepName, step]];
} else {
    stepsToRun = steps.entries();
}

let exitCode = 0;

for (const [stepName, step] of stepsToRun) {
    console.log(stepName);

    // Source file listing may change; pull it at each step.
    const sourceFiles = project.getSourceFiles(sourceFileGlobs);

    for (const sourceFile of sourceFiles) {
        step(sourceFile);
    }

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
