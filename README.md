# ytb2rss

A small Bun + TypeScript CLI that converts a text file of YouTube channel IDs into feed URLs or OPML. No API key, browser, or login is needed. Raw IDs are converted entirely offline; handles and channel URLs are also supported through a plain HTTP lookup.

## Setup

Install [Bun](https://bun.sh/docs/installation) 1.2 or newer, then:

```sh
bun install
```

Uses Bun's built-in HTTP client and HTML parser, plus the small `entities` package to decode HTML text correctly. Development dependencies provide TypeScript checking and Bun types.

## Standalone CLI

Find release notes and downloadable builds on the [GitHub Releases page](https://github.com/davidmasp/ytb2rss/releases).

Build a binary for the current operating system and CPU:

```sh
bun run build
./dist/ytb2rss --help
./dist/ytb2rss channels.txt --format text --output feeds.txt
./dist/ytb2rss channels.txt --format opml --output subscriptions.opml
```

The [standalone executable](https://bun.sh/docs/bundler/executables) includes the Bun runtime and package dependencies. Once built, the single binary can be copied elsewhere and run without Bun, Node.js, `node_modules`, or the project source. Bun is only needed to develop or rebuild it. Build a separate binary for each operating system and CPU architecture.

To install it as `ytb2rss` for your own user on macOS or Linux:

```sh
mkdir -p "$HOME/.local/bin"
install -m 755 dist/ytb2rss "$HOME/.local/bin/ytb2rss"
export PATH="$HOME/.local/bin:$PATH"
ytb2rss --help
```

Add `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc` (or your shell's configuration file) to keep the command available in new terminals. You can then call `ytb2rss` from any folder. Relative input, output, and cache paths refer to your current folder. Rebuild and repeat the `install` command to update it.

## Input

One channel ID per line:

```text
UCBLCvUUCiSqBCEc-TqZ9rGw
UC_x5XG1OV2P6uZZ5FSM9Ttw
```

You can also mix in handles and channel URLs:

```text
# Comments and blank lines are ignored.
@juanrallo
https://www.youtube.com/@GoogleDevelopers
https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw
```

Both Unix and Windows line endings work. `/user/…` and `/c/…` channel URLs are supported, along with channel tabs such as `/videos`. Video and playlist URLs are rejected. Inputs and resolved channels are deduplicated in first-seen order.

## Run

```sh
# One feed URL per line, written to a file.
bun run convert examples/channels.txt --format text --output feeds.txt

# An OPML 2.0 file for importing into a feed reader.
bun run convert examples/channels.txt --format opml --output subscriptions.opml

# Output defaults to a plain list on stdout, so redirection works too.
bun run convert examples/channels.txt > feeds.txt

# Save failed entries for review, while still exporting successful entries.
bun run convert channels.txt -f opml -o subscriptions.opml --failures failures.json

bun run convert --help
```

### Categories for Miniflux

OPML is an XML outline tree of feed subscriptions. A category is a parent `<outline>` containing feed outlines. Miniflux's [OPML parser](https://github.com/miniflux/v2/blob/main/internal/reader/opml/parser.go) reads the parent outline's name as each child feed's category.

Use `--category` with OPML output to put all channels in the file into one named category:

```sh
ytb2rss channels.txt --format opml --category "YouTube" --output feeds.opml
# Or from source:
bun run convert channels.txt --format opml --category "YouTube" --output feeds.opml
```

Category names can contain spaces and Unicode. Miniflux [reuses a matching category or creates it](https://github.com/miniflux/v2/blob/main/internal/reader/opml/handler.go). Its importer skips feeds already subscribed to, so re-importing an OPML file does not move existing feeds to a different category. The category option requires OPML output; a plain text list cannot store it.

Diagnostics and the final count go to stderr, leaving stdout suitable for piping. Output files are replaced atomically. Parent directories must already exist. Use `--output` for file writes rather than redirecting stdout onto the input file.

Exit codes: **0** for success, **1** when some input lines failed (successful feeds are still exported), **2** for invalid CLI arguments or file/storage errors. Empty/comment-only input produces an empty list or an OPML document with an empty body. An ID's shape is checked locally; its existence and feed availability are not verified. OPML titles for offline IDs use the IDs themselves.

## Lookup reliability

Raw IDs and `/channel/UC…` URLs never make HTTP requests. For handles and legacy channel URLs, the tool first reads the channel page's feed link, with channel-specific metadata and canonical links as fallbacks. It does not execute scripts or interact with cookie banners. YouTube can still return consent or blocking pages; these become failed entries rather than blocking the batch indefinitely.

Lookups run sequentially, with a 500 ms delay between attempts. Each attempt has a 10-second timeout covering redirects and response-body reads. Network errors, timeouts, HTTP 429, and server errors get at most two retries with backoff. Missing metadata, consent pages, and other HTTP errors are not retried. Redirects are limited and restricted to YouTube; pages are capped at 5 MB.

```sh
bun run convert channels.txt --timeout 15000 --retries 1 --delay 1000
```

Successful HTTP resolutions are saved immediately in `.ytb2rss-cache.json`. Rerunning an interrupted job reuses these lookups; failed entries are tried again. Cached aliases expire after seven days because handles can change. Exports are written after the batch completes.

```sh
bun run convert channels.txt --cache my-cache.json
bun run convert channels.txt --no-cache
```

## Tests

```sh
bun test
bun run typecheck
```

Tests use local fixtures, mocked HTTP responses, and temporary files; they do not contact YouTube. Binary integration tests compile a temporary executable and run it outside the project with no Bun on `PATH`.

## Reuse from a future server or API

The converter has no CLI or file-system dependencies. Import it directly:

```ts
import { convertChannels, formatFeeds } from "./src/index.ts";

const result = await convertChannels("UCBLCvUUCiSqBCEc-TqZ9rGw\n");
const opml = formatFeeds(result.feeds, "opml");
const categorizedOpml = formatFeeds(result.feeds, "opml", { category: "YouTube" });
```

`convertChannels` also accepts an injected resolver, cache, and success callback. A future HTTP endpoint can reuse this module and supply its own persistence without changing the CLI.
