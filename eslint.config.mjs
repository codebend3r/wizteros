import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/',
      'web/dist/',
      'venv/',
      'stripe-bridge/',
      'wizarr-data/',
      'tautulli-config/',
      '.netlify/',
      '.superpowers/',
      '.claude/',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    extends: [js.configs.recommended],
  },
  {
    files: ['scripts/**/*.{js,mjs}', 'eslint.config.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: tseslint.configs.recommended,
    languageOptions: { globals: { ...globals.browser, ...globals.vitest } },
    rules: {
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ForInStatement',
          message: 'Never use for/in — use Object.keys/entries with array methods.',
        },
        {
          selector: 'ForOfStatement',
          message: 'Never use for/of — use Array.prototype methods (map/filter/reduce).',
        },
      ],
    },
  },
  prettier,
)
