import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

export default defineConfig([
	{
		ignores: ["AE Demo Vault/**", "main.js", "node_modules/**", "types/obsidian-review.d.ts"],
	},
	...obsidianmd.configs.recommended,
	{
		files: ["**/*.ts"],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"obsidianmd/ui/sentence-case": [
				"warn",
				{ brands: ["Alternative Explorer", "Bookmarks", "YYYY-MM-DD"] },
			],
		},
	},
	{
		files: ["*.mjs"],
		rules: {
			"no-undef": "off",
			"obsidianmd/no-nodejs-modules": "off",
		},
	},
]);
