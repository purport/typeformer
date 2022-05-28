import * as path from "path";
import { fileURLToPath } from "url";

// dist
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const packageRoot = path.resolve(__dirname, "..");
