import * as path from "path";
import { fileURLToPath } from "url";

// dist
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const packageRoot = path.resolve(__dirname, "..");

export const beforePatchesDir = path.resolve(packageRoot, "patches-before");
export const afterPatchesDir = path.resolve(packageRoot, "patches-after");
