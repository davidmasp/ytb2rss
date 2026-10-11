# Build a standalone executable for this computer.
build:
    mkdir -p dist
    bun build ./src/cli.ts --compile --minify --outfile ./dist/ytb2rss

# Cross-compile for a Bun target, e.g. `just build-target bun-linux-x64`.
[arg('target', pattern='bun-(darwin-(x64|arm64)|linux-(x64|arm64)(-musl)?|windows-(x64|arm64))')]
build-target target:
    mkdir -p dist
    bun build ./src/cli.ts --compile --minify --target='{{target}}' --outfile './dist/ytb2rss-{{target}}'
