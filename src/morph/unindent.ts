import { Project } from "ts-morph";

export function unindent(project: Project): void {
    project.getSourceFiles().forEach((f) => {
        f.getModules().forEach((m) => {
            if (m.getDeclarationKind() !== "namespace") return;
            const b = m.getBodyOrThrow();
            f.unindent([b.getStart(), b.getEnd()]);
        });
    });
}
