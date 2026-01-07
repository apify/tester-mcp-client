import apify from '@apify/eslint-config';

// eslint-disable-next-line import/no-default-export
export default [
    { ignores: ['**/dist', 'src/public/assets/**'] }, // Ignores need to happen first
    ...apify,
    {
        languageOptions: {
            sourceType: 'module',

            parserOptions: {
                project: 'tsconfig.eslint.json',
            },
        },
    },
    {
        files: ['frontend/**/*.{ts,tsx}'],
        rules: {
            'import/extensions': 'off',
            '@typescript-eslint/no-floating-promises': 'off',
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': 'off',
            '@typescript-eslint/promise-function-async': 'off',
            'comma-dangle': 'off',
            'consistent-return': 'off',
            'func-call-spacing': 'off',
            'implicit-arrow-linebreak': 'off',
            'import/no-default-export': 'off',
            'import/order': 'off',
            indent: 'off',
            'max-len': 'off',
            'no-confusing-arrow': 'off',
            'no-nested-ternary': 'off',
            'no-param-reassign': 'off',
            'no-spaced-func': 'off',
            'no-underscore-dangle': 'off',
            'no-use-before-define': 'off',
            'no-void': 'off',
            'operator-linebreak': 'off',
            'prefer-destructuring': 'off',
            quotes: 'off',
            'react-hooks/exhaustive-deps': 'off',
            semi: 'off',
            'no-console': 'off',
        },
    },
    {
        files: ['frontend/vite.config.ts'],
        rules: {
            'import/no-default-export': 'off',
        },
    },
    {
        files: ['frontend/postcss.config.mjs'],
        rules: {
            'import/no-default-export': 'off',
            indent: 'off',
            quotes: 'off',
            semi: 'off',
        },
    },
];
