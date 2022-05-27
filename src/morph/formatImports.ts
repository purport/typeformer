import { Project } from "ts-morph";

import { formatImports as doFormatImports, getTsSourceFiles, isNamespaceBarrel } from "./utilities";

export function formatImports(project: Project): void {
    for (const sourceFile of getTsSourceFiles(project)) {
        if (isNamespaceBarrel(sourceFile)) {
            continue;
        }
        doFormatImports(sourceFile);
    }
}
