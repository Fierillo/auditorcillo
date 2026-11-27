import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['node_modules/', '.venv/', 'mint-local/', 'out/'] },
  js.configs.recommended,
  { files: ['src/**/*.ts', 'test/**/*.ts'], extends: [tseslint.configs.recommended], languageOptions: { globals: globals.node } },
  { files: ['site/**/*.d.ts'], extends: [tseslint.configs.recommended] },
  { files: ['site/**/*.js'], languageOptions: { globals: globals.browser } },
);
