import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeConfigWatcher, RuntimeSettingsHolder } from "../../src/adapters/runtime-config.js";
import { DEFAULT_RUNTIME_SETTINGS } from "../../src/config.js";
import type { RuntimeSettings } from "../../src/config.js";
import type { Logger } from "../../src/usecases/ports.js";

function recordingLogger() {
  const lines: Array<{ level: string; fields: object; message: string | undefined }> = [];
  const logger: Logger = {
    info: (fields, message) => lines.push({ level: "info", fields, message }),
    warn: (fields, message) => lines.push({ level: "warn", fields, message }),
    error: (fields, message) => lines.push({ level: "error", fields, message }),
  };
  return { lines, logger };
}

describe("RuntimeSettingsHolder", () => {
  it("hands out the market rules and takes new settings", () => {
    const holder = new RuntimeSettingsHolder(DEFAULT_RUNTIME_SETTINGS);
    expect(holder.current()).toEqual(DEFAULT_RUNTIME_SETTINGS.marketRules);
    expect(holder.autoClose()).toEqual({ enabled: true, intervalMs: 15_000 });
    const next: RuntimeSettings = { logLevel: "debug", marketRules: { fundingMin: 1, fundingMax: 2, minLeadMs: 0 }, autoClose: { enabled: false, intervalMs: 2000 } };
    holder.set(next);
    next.marketRules.fundingMax = 99;
    next.autoClose.enabled = true;
    expect(holder.get()).toEqual({ logLevel: "debug", marketRules: { fundingMin: 1, fundingMax: 2, minLeadMs: 0 }, autoClose: { enabled: false, intervalMs: 2000 } });
    expect(holder.autoClose()).toEqual({ enabled: false, intervalMs: 2000 });
  });
});

describe("RuntimeConfigWatcher", () => {
  let directory: string;
  let file: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "markets-runtime-"));
    file = join(directory, "runtime.env");
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  });

  it("applies the file when it appears and again only when its content changes", async () => {
    const { lines, logger } = recordingLogger();
    const changes: RuntimeSettings[] = [];
    const watcher = new RuntimeConfigWatcher({ file, pollMs: 1000, startup: DEFAULT_RUNTIME_SETTINGS, logger, onChange: (s) => changes.push(s) });

    expect(await watcher.checkNow()).toBe(false);
    expect(await watcher.checkNow()).toBe(false);
    expect(lines.filter((line) => line.level === "warn")).toHaveLength(1);

    await writeFile(file, "LOG_LEVEL=debug\nMARKET_FUNDING_MAX=5000\nUNKNOWN=1\n");
    expect(await watcher.checkNow()).toBe(true);
    expect(changes).toEqual([{ logLevel: "debug", marketRules: { ...DEFAULT_RUNTIME_SETTINGS.marketRules, fundingMax: 5000 }, autoClose: DEFAULT_RUNTIME_SETTINGS.autoClose }]);
    expect(lines.some((line) => line.level === "warn" && JSON.stringify(line.fields).includes("UNKNOWN"))).toBe(true);
    expect(await watcher.checkNow()).toBe(false);

    await writeFile(file, "");
    expect(await watcher.checkNow()).toBe(true);
    expect(changes[1]).toEqual(DEFAULT_RUNTIME_SETTINGS);
  });

  it("logs an error when the kill switch fails closed, and applies the switched-off settings", async () => {
    const { lines, logger } = recordingLogger();
    const changes: RuntimeSettings[] = [];
    const watcher = new RuntimeConfigWatcher({ file, pollMs: 1000, startup: DEFAULT_RUNTIME_SETTINGS, logger, onChange: (s) => changes.push(s) });

    await writeFile(file, "AUTO_CLOSE_ENABLED=flase\n");
    expect(await watcher.checkNow()).toBe(true);

    expect(changes[0]?.autoClose.enabled).toBe(false);
    expect(lines.some((line) => line.level === "error" && JSON.stringify(line.fields).includes(file))).toBe(true);
  });

  it("polls after start until stop", async () => {
    await writeFile(file, "LOG_LEVEL=warn\n");
    const { logger } = recordingLogger();
    const changes: RuntimeSettings[] = [];
    const watcher = new RuntimeConfigWatcher({ file, pollMs: 1000, startup: DEFAULT_RUNTIME_SETTINGS, logger, onChange: (s) => changes.push(s) });
    const check = vi.spyOn(watcher, "checkNow");
    vi.useFakeTimers();
    await watcher.start();
    expect(changes.map((s) => s.logLevel)).toEqual(["warn"]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(check).toHaveBeenCalledTimes(4);
    await watcher.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(check).toHaveBeenCalledTimes(4);
  });
});
