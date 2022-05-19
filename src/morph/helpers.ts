import { Project, SourceFile } from "ts-morph";

const sourceFileGlobs = ["src/**/*.ts", "!**/*.d.ts"];
const tsconfigGlob = "src/**/tsconfig*.json";

export function addSourceFilesToProject(project: Project) {
    project.addSourceFilesAtPaths(sourceFileGlobs);
}

export function getSourceFilesFromProject(project: Project): SourceFile[] {
    return project.getSourceFiles(sourceFileGlobs);
}

export function addTsConfigsToProject(project: Project) {
    project.addSourceFilesAtPaths(tsconfigGlob);
}

export function getTsConfigsFromProject(project: Project): SourceFile[] {
    return project.getSourceFiles(tsconfigGlob);
}
