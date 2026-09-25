import { appendFile, mkdir, mkdtemp, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { fingerprintSource, sourceLogRoots } from "./fingerprint";

let root: string;
let home: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tokenmaxxing-fingerprint-"));
  home = join(root, "home");
  await mkdir(home);
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

async function write(path: string, content = "{}\n") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function digest(source: Parameters<typeof fingerprintSource>[0], env: Record<string, string> = {}) {
  return fingerprintSource(source, { cwd: root, env, home });
}

describe("fingerprintSource", () => {
  it("is stable for untouched logs and changes when a rollout grows", async () => {
    const rollout = join(home, ".codex", "sessions", "2026", "09", "25", "rollout-a.jsonl");
    await write(rollout);

    const first = await digest("codex");
    expect(await digest("codex")).toEqual(first);
    expect(first).toMatchObject({ bytes: 3, files: 1 });

    await appendFile(rollout, '{"type":"event_msg"}\n');
    expect((await digest("codex"))?.digest).not.toBe(first?.digest);
  });

  it("notices a rewrite that keeps the size", async () => {
    const rollout = join(home, ".codex", "sessions", "rollout-a.jsonl");
    await write(rollout, "aaaa\n");
    await utimes(rollout, new Date("2026-09-24T10:00:00Z"), new Date("2026-09-24T10:00:00Z"));
    const before = await digest("codex");

    await write(rollout, "bbbb\n");
    await utimes(rollout, new Date("2026-09-24T11:00:00Z"), new Date("2026-09-24T11:00:00Z"));
    expect((await digest("codex"))?.digest).not.toBe(before?.digest);
  });

  it("covers archived Codex sessions, so archiving a rollout is a change", async () => {
    const live = join(home, ".codex", "sessions", "2026", "09", "20", "rollout-a.jsonl");
    await write(live);
    await mkdir(join(home, ".codex", "archived_sessions"));
    const before = await digest("codex");

    await rename(live, join(home, ".codex", "archived_sessions", "rollout-a.jsonl"));
    const after = await digest("codex");
    expect(after?.digest).not.toBe(before?.digest);
    expect(after?.files).toBe(1);
  });

  it("ignores files ccusage never reads", async () => {
    await write(join(home, ".codex", "sessions", "rollout-a.jsonl"));
    const before = await digest("codex");

    await write(join(home, ".codex", "sessions", "notes.txt"), "scratch");
    await write(join(home, ".codex", "log", "codex-tui.log"), "log line");
    expect(await digest("codex")).toEqual(before);
  });

  it("treats a log directory appearing as a change", async () => {
    const empty = await digest("gemini");
    expect(empty).toMatchObject({ bytes: 0, files: 0 });
    expect(await digest("gemini")).toEqual(empty);

    await write(join(home, ".gemini", "tmp", "project", "chats", "session.json"));
    expect((await digest("gemini"))?.digest).not.toBe(empty?.digest);
  });

  it("follows CODEX_HOME, including comma-separated homes", async () => {
    const work = join(root, "work-codex");
    const personal = join(root, "personal-codex");
    await write(join(work, "sessions", "rollout-a.jsonl"));
    await write(join(personal, "archived_sessions", "rollout-b.jsonl"));
    await write(join(home, ".codex", "sessions", "rollout-default.jsonl"));
    const env = { CODEX_HOME: `${work}, ${personal}` };

    expect(await digest("codex", env)).toMatchObject({ files: 2 });

    await write(join(home, ".codex", "sessions", "rollout-other.jsonl"));
    const before = await digest("codex", env);
    await appendFile(join(personal, "archived_sessions", "rollout-b.jsonl"), "{}\n");
    expect((await digest("codex", env))?.digest).not.toBe(before?.digest);
  });

  it("reads a Codex home without sessions directories directly, like ccusage", async () => {
    const codexHome = join(root, "flat-codex");
    await write(join(codexHome, "rollout-a.jsonl"));

    expect(await digest("codex", { CODEX_HOME: codexHome })).toMatchObject({ files: 1 });
  });

  it("resolves CLAUDE_CONFIG_DIR entries that name the config dir or projects/ itself", async () => {
    const roots = await sourceLogRoots("claude", {
      cwd: root,
      env: { CLAUDE_CONFIG_DIR: "~/work-claude, /data/claude/projects" },
      home,
    });

    expect(roots?.filter((entry) => entry.kind === "tree").map((entry) => entry.path)).toEqual([
      join(home, "work-claude", "projects"),
      "/data/claude/projects",
    ]);
  });

  it("defaults Claude to both the XDG and legacy config dirs", async () => {
    await write(join(home, ".claude", "projects", "repo", "session.jsonl"));
    await write(join(root, "xdg", "claude", "projects", "repo", "session.jsonl"));

    expect(await digest("claude", { XDG_CONFIG_HOME: join(root, "xdg") })).toMatchObject({
      files: 2,
    });
  });

  it("tracks SQLite write-ahead logs but not shared-memory files", async () => {
    await write(join(home, ".hermes", "state.db"), "db");
    await write(join(home, ".hermes", "state.db-shm"), "shm");
    const before = await digest("hermes");
    expect(before).toMatchObject({ files: 1 });

    await write(join(home, ".hermes", "state.db-shm"), "shm changed");
    expect(await digest("hermes")).toEqual(before);

    await write(join(home, ".hermes", "state.db-wal"), "wal");
    expect((await digest("hermes"))?.digest).not.toBe(before?.digest);
  });

  it("covers OpenCode message files and databases", async () => {
    const dataDir = join(root, "opencode-data");
    await write(join(dataDir, "storage", "message", "session-a", "msg-1.json"));
    await write(join(dataDir, "opencode.db"), "db");
    await write(join(dataDir, "opencode-dev.db"), "db");
    await write(join(dataDir, "snapshot", "objects", "ab.json"));

    expect(await digest("opencode", { OPENCODE_DATA_DIR: dataDir })).toMatchObject({
      files: 3,
    });
  });

  it("includes a Copilot OTel exporter file outside the Copilot home", async () => {
    const exporter = join(root, "copilot-otel.jsonl");
    await write(exporter);
    await write(join(home, ".copilot", "session-state", "session-a", "events.jsonl"));

    expect(await digest("copilot", { COPILOT_OTEL_FILE_EXPORTER_PATH: exporter })).toMatchObject({
      files: 2,
    });
  });

  it("re-runs every source when a ccusage config file changes", async () => {
    await write(join(home, ".codex", "sessions", "rollout-a.jsonl"));
    const before = await digest("codex");

    await write(join(home, ".claude", "ccusage.json"), '{"defaults":{}}');
    expect((await digest("codex"))?.digest).not.toBe(before?.digest);
  });

  it("gives up on pi when a ccusage config could point it at other stores", async () => {
    await write(join(home, ".pi", "agent", "sessions", "session.jsonl"));
    expect(await digest("pi")).not.toBeNull();

    await write(join(root, ".ccusage", "ccusage.json"), '{"pi":{"stores":[]}}');
    expect(await digest("pi")).toBeNull();
  });
});
