import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

/** Viewer and framework packages, banned in every file. */
const agnosticGuard = {
  group: [
    "vue",
    "vue/*",
    "pinia",
    "pinia/*",
    "element-plus",
    "element-plus/*",
    "aws-amplify",
    "@aws-amplify/*",
    "@pennsieve-viz/*",
  ],
  message:
    "Do not import viewer or framework packages; the library is framework-agnostic.",
};

/** zarrita, banned outside src/zarr.ts and src/stores/**. */
const zarritaGuard = {
  group: ["zarrita", "zarrita/*"],
  message:
    "Import zarrita only in src/zarr.ts and src/stores/**. Every other module must be testable against an in-memory Store.",
};

/**
 * Node builtins, banned outside src/stores/**. The node:* pattern matches only prefixed
 * imports; bare specifiers must be listed by name, and this list covers the commonly
 * used builtins.
 */
const nodeGuard = {
  group: [
    "node:*",
    "fs",
    "fs/*",
    "path",
    "os",
    "url",
    "buffer",
    "stream",
    "http",
    "https",
    "net",
    "crypto",
    "events",
    "util",
    "zlib",
    "child_process",
    "worker_threads",
  ],
  message:
    "Import Node builtins only in src/stores/**. The rest of the reader must run in a browser.",
};

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**"] },
  {
    files: ["**/*.ts"],
    extends: [...tseslint.configs.recommended],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [agnosticGuard, zarritaGuard, nodeGuard] },
      ],
    },
  },
  {
    // zarrita is allowed here; Node builtins are not.
    files: ["src/zarr.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [agnosticGuard, nodeGuard] },
      ],
    },
  },
  {
    // zarrita and Node builtins are both allowed here.
    files: ["src/stores/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [agnosticGuard] }],
    },
  },
  {
    // Tests run on Node and may use Node builtins for fixtures. The zarrita ban still
    // applies.
    files: ["src/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [agnosticGuard, zarritaGuard] },
      ],
    },
  },
  prettier,
);
