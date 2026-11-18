import {nodeConfig} from '@docouno/env/eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

const tsconfigRootDir = import.meta.dirname;

export default [
  ...nodeConfig(tsconfigRootDir),
  {
    name: 'quotum-hub/server-project',
    files: ['server/**/*.ts'],
    languageOptions: {
      parserOptions: {project: ['./tsconfig.test.json'], tsconfigRootDir},
    },
  },
  {
    name: 'quotum-hub/ui-app-project',
    files: ['ui/**/*.{ts,tsx}', 'vite.config.ts', 'vite.bundle.config.ts'],
    ignores: ['ui/test/**'],
    plugins: {'react-hooks': reactHooks},
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        ecmaFeatures: {jsx: true},
        project: ['./tsconfig.app.json'],
        tsconfigRootDir,
      },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
    },
  },
  {
    name: 'quotum-hub/ui-test-project',
    files: ['ui/test/**/*.ts'],
    languageOptions: {
      parserOptions: {project: ['./tsconfig.ui-test.json'], tsconfigRootDir},
    },
  },
  {
    name: 'quotum-hub/demo-ui-project',
    files: ['demo/ui/**/*.tsx', 'vite.demo.config.ts'],
    plugins: {'react-hooks': reactHooks},
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        ecmaFeatures: {jsx: true},
        project: ['./tsconfig.demo-ui.json'],
        tsconfigRootDir,
      },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
    },
  },
  {
    name: 'quotum-hub/demo-bench-project',
    files: ['demo/**/*.ts', 'bench/**/*.ts'],
    languageOptions: {
      parserOptions: {project: ['./tsconfig.demo.json'], tsconfigRootDir},
    },
  },
  {
    // Devkit requires visible configuration rather than inline eslint-disable comments.
    // Mandatory safety gates (@typescript-eslint/no-floating-promises and
    // @typescript-eslint/no-unsafe-assignment) remain 'error' across all TypeScript files.
    name: 'quotum-hub/adopted-codebase-policy',
    files: ['**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'],
    rules: {
      curly: 'off',
      eqeqeq: ['error', 'always', {null: 'ignore'}],
      'prefer-const': ['error', {destructuring: 'all'}],
      'no-empty': ['error', {allowEmptyCatch: true}],
      'no-control-regex': 'off',
      'no-regex-spaces': 'off',
      'no-unsafe-finally': 'off',
      'preserve-caught-error': 'off',
      'require-yield': 'off',
    },
  },
  {
    name: 'quotum-hub/typescript-policy',
    files: ['**/*.{ts,tsx,mts,cts}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {prefer: 'type-imports', disallowTypeAnnotations: false},
      ],
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          ignoreVoid: true,
          allowForKnownSafeCalls: [
            {from: 'package', name: ['test', 'describe', 'it', 'suite'], package: 'node:test'},
          ],
        },
      ],
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-misused-promises': ['error', {checksVoidReturn: {attributes: false}}],
      '@typescript-eslint/await-thenable': 'error',
      // Unused locals/parameters are enforced by tsc (noUnusedLocals + noUnusedParameters).
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/restrict-plus-operands': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
      '@typescript-eslint/only-throw-error': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'off',
    },
  },
];
