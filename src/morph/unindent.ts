import { Project, SourceFile } from "ts-morph";

export function unindent(sourceFile: SourceFile): void {
    sourceFile.getModules().forEach((module) => {
        if (module.getDeclarationKind() !== "namespace") return;
        const body = module.getBodyOrThrow();
        sourceFile.unindent([body.getStart(), body.getEnd()]);
    });
}
