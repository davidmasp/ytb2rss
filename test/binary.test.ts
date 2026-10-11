import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/version.ts";

const ID = "UCBLCvUUCiSqBCEc-TqZ9rGw";
const OTHER = "UC_x5XG1OV2P6uZZ5FSM9Ttw";
const FEED = `https://www.youtube.com/feeds/videos.xml?channel_id=${ID}`;
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
let directory: string;
let binary: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "ytb2rss-binary-"));
  binary = join(directory, process.platform === "win32" ? "ytb2rss.exe" : "ytb2rss");
  const build = Bun.spawn([process.execPath, "build", CLI, "--compile", "--minify", "--outfile", binary], {
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited,
  ]);
  if (code !== 0) throw new Error(`Binary build failed:\n${stdout}${stderr}`);
}, 30_000);

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function runBinary(args: string[]) {
  const child = Bun.spawn([binary, ...args], {
    cwd: directory,
    env: { ...process.env, PATH: join(directory, "no-bun-installed") },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

describe("standalone binary", () => {
  test("shows the embedded package version without project files or Bun on PATH", async () => {
    const result = await runBinary(["--version"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`ytb2rss ${VERSION}\n`);
    expect(result.stderr).toBe("");
  });

  test("shows help without Bun on PATH or project files in the working directory", async () => {
    const result = await runBinary(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: ytb2rss <channels.txt>");
    expect(result.stderr).toBe("");
  });

  test("exports and deduplicates offline IDs from a file beside the copied binary", async () => {
    await writeFile(join(directory, "ids.txt"), `${ID}\nhttps://youtube.com/channel/${ID}\n${OTHER}\n`);
    const result = await runBinary(["ids.txt", "--no-cache"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${FEED}\nhttps://www.youtube.com/feeds/videos.xml?channel_id=${OTHER}\n`);
    expect(result.stderr).toContain("2 feed(s), 1 duplicate(s), 0 failure(s).");
  });

  test("exports OPML from cached handles, with dependencies embedded and paths relative to cwd", async () => {
    await writeFile(join(directory, "handles.txt"), "@example\n");
    await writeFile(join(directory, "cache.json"), JSON.stringify({
      version: 1,
      entries: [["@example", { channelId: ID, title: 'Café & <news> "quoted"', resolvedAt: Date.now() }]],
    }));
    const result = await runBinary(["handles.txt", "--cache", "cache.json", "-f", "opml", "--category", "YouTube & Tech", "-o", "feeds.opml"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    const output = await readFile(join(directory, "feeds.opml"), "utf8");
    expect(output).toContain('<opml version="2.0">');
    expect(output).toContain('<outline text="YouTube &amp; Tech" title="YouTube &amp; Tech">');
    expect(output).toContain(`xmlUrl="${FEED}"`);
    expect(output).toContain("Café &amp; &lt;news&gt; &quot;quoted&quot;");
  });

  test("preserves partial-failure output and exit code in the compiled executable", async () => {
    await writeFile(join(directory, "partial.txt"), `# comment\n${ID}\ninvalid\n`);
    const result = await runBinary(["partial.txt", "--no-cache", "--failures", "failures.json"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe(`${FEED}\n`);
    expect(result.stderr).toContain("Line 3 (invalid)");
    expect(JSON.parse(await readFile(join(directory, "failures.json"), "utf8")))
      .toMatchObject([{ line: 3, input: "invalid" }]);
  });

  test("rejects invalid flags with the documented exit code", async () => {
    const result = await runBinary(["--unknown"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Error:");
  });
});
