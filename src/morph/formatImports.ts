import { Project } from "ts-morph";

import { formatImports as doFormatImports, getTsSourceFiles } from "./utilities.js";

export function formatImports(project: Project): void {
    for (const sourceFile of getTsSourceFiles(project)) {
        doFormatImports(sourceFile);
    }
}
