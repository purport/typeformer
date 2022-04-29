#!/usr/bin/env node
import { existsSync } from "fs";
import { resolve } from "path";

import { ProjectTransformerFactory, transformAndMerge, transformProjectInPlace } from ".";
import { getExplicitifyTransformFactoryFactory } from "./transforms/explicitify";
import { getInlineImportsTransformFactoryFactory } from "./transforms/inlineImports";
import { getStripNamespacesTransformFactoryFactory } from "./transforms/stripNamespaces";

const fileName = process.argv[2];
if (!fileName || !existsSync(fileName)) {
    console.error(
        (fileName ? `File ${fileName} not found` : `Argument expected`) +
            ` - provide a path to the root project tsconfig.`
    );
    process.exit(1);
}
const configPath = resolve(process.cwd(), fileName);

const stepName = process.argv[3];
if (!stepName) {
    transformProjectInPlace(configPath);
    process.exit(0);
}

const steps = new Map<string, ProjectTransformerFactory>([
    ["explicitify", getExplicitifyTransformFactoryFactory],
    ["stripNamespaces", getStripNamespacesTransformFactoryFactory],
    ["inlineImports", getInlineImportsTransformFactoryFactory],
]);

const step = steps.get(stepName);
if (!step) {
    console.error(`Unknown step ${stepName}`);
    process.exit(1);
}

console.log(stepName);
transformAndMerge(configPath, step);
