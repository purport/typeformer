import { Project } from "ts-morph";

import { getSourceFilesFromProject } from "./helpers";

export function unindent(project: Project): void {
    getSourceFilesFromProject(project).forEach((sourceFile) => {
        sourceFile.getModules().forEach((module) => {
            if (module.getDeclarationKind() !== "namespace") return;
            const body = module.getBodyOrThrow();
            sourceFile.unindent([body.getStart(), body.getEnd()]);
        });
    });
}
