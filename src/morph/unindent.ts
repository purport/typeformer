import { ModuleDeclarationKind, Project } from "ts-morph";

import { getSourceFilesFromProject } from "./utilities";

export function unindent(project: Project): void {
    getSourceFilesFromProject(project).forEach((sourceFile) => {
        sourceFile.getModules().forEach((module) => {
            if (module.getDeclarationKind() !== ModuleDeclarationKind.Namespace) {
                return;
            }

            const body = module.getBodyOrThrow();
            sourceFile.unindent([body.getStart(), body.getEnd()]);
        });
    });
}
