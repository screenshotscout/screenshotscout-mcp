import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

const typedFiles = ["**/*.ts"];

export default tseslint.config(
  {
    ignores: ["coverage/**", "dist/**", "mcpb/server/**", "node_modules/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: typedFiles,
  })),
  {
    files: typedFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
