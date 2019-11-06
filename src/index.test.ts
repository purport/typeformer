import * as fs from "fs";
import * as path from "path";
import "./directorySnapshot";
import {transformProjectAtPath} from "./";

const testDir = path.join(__dirname, "../test")
const fixturesDir = path.join(testDir, "fixtures");

describe("the project transform", () => {
    const directoryResult = fs.readdirSync(fixturesDir);
    for (const dir of directoryResult) {
        it(`with ${dir}`, () => {
            const baselineLocalDir = path.join(testDir, "baseline", "local", dir);
            const baselineReferenceDir = path.join(testDir, "baseline", "reference", dir);
            transformProjectAtPath(path.join(fixturesDir, dir, "input", "tsconfig.json"), baselineLocalDir);
            expect(baselineLocalDir).toMatchDirectorySnapshot(baselineReferenceDir);
        });
    }
});
