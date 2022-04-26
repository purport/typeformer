import { Project } from "ts-morph";

const project = new Project({
    tsConfigFilePath: "src/tsconfig.json", // won't follow references
});

// get all files, which is what following the tsconfig references gets anyway,
// except for three one-file directories with non-namespace/empty files.
project.addSourceFilesAtPaths(["src/**/*.ts", "!**/*.d.ts"]);

project.getSourceFiles().forEach(f => {
    f.getModules().forEach(m => {
        if (m.getDeclarationKind() !== "namespace") return;
        const b = m.getBodyOrThrow();
        f.unindent([b.getStart(), b.getEnd()]);
    });
});

project.saveSync();
