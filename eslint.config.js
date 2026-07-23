import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

/** viewer/framework imports that would break the reader's framework agnosticism. */
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
    "The core is framework agnostic and disables viewer/framework imports.",
};

/** zarrita may be imported only in src/zarr.ts and src/stores/**. Every other module should remain zarrita agnostic. */
const zarritaGuard = {
  group: ["zarrita", "zarrita/*"],
  message:
    "Import zarrita only in src/zarr.ts and src/stores/**. Every other module must be testable against an in-memory Store.",
};

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**"] },
  {
    files: ["**/*.ts"],
    extends: [...tseslint.configs.recommended],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [agnosticGuard, zarritaGuard] },
      ],
    },
  },
  {
    files: ["src/zarr.ts", "src/stores/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [agnosticGuard] }],
    },
  },
  prettier,
);
