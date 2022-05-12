import { Project, SourceFile } from "ts-morph";

const sourceFileGlobs = ["src/**/*.ts", "!**/*.d.ts"];

export function addSourceFilesToProject(project: Project) {
    project.addSourceFilesAtPaths(sourceFileGlobs);
}

export function getSourceFilesFromProject(project: Project): SourceFile[] {
    return project.getSourceFiles(sourceFileGlobs);
}
