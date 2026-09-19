// Node needs a file extension on relative imports; the app's TypeScript
// sources leave it off. This hook tries ".ts" for such imports so tests can
// load modules that import each other. Registered with --import.
import { register } from "node:module";

register(new URL("./ts-resolve-hook.mjs", import.meta.url));
