// Jest-only Babel transform. Uses an explicit config (instead of .babelrc) so
// it can also compile cognimates-l10n, which ships untranspiled ES modules
// inside node_modules (see "transformIgnorePatterns" in package.json).
const babelJest = require('babel-jest');

module.exports = babelJest.createTransformer({
    babelrc: false,
    plugins: [
        '@babel/plugin-syntax-dynamic-import',
        '@babel/plugin-transform-async-to-generator',
        '@babel/plugin-proposal-object-rest-spread'
    ],
    presets: [
        ['@babel/preset-env', {targets: {node: 'current'}}],
        '@babel/preset-react'
    ]
});
