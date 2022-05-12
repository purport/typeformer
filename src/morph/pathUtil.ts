import { FileUtils, StandardizedFilePath } from "@ts-morph/common";

export function getTSStyleRelativePath(from: StandardizedFilePath, to: StandardizedFilePath): string {
    let result: string = FileUtils.getRelativePathTo(FileUtils.getDirPath(from), to);
    if (!result.startsWith(".")) {
        result = `./${result}`;
    }
    return result.replace(/\\/g, "/");
}
