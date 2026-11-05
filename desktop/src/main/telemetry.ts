// Opt-in, privacy-first LOCAL error telemetry (EA-M6). Nothing leaves the
// machine: records are appended to a JSONL file under userData, and only when
// the user has explicitly enabled telemetry in Settings (default OFF). This
// makes field failures inspectable for an auto-updating client — a bad release
// leaves a local trail the user can export/share — without shipping their data
// anywhere. A remote sink can later hang off the same enable flag + hook.
import { app, ipcMain, BrowserWindow } from "electron";
import fs from "fs";
import path from "path";
import { readSetting } from "./database";
import { buildRecord, trimJsonl, type TelemetryInput } from "./telemetry-format";
import { debugLog } from "./debug-log";

const LOG_FILE = "telemetry.jsonl";
const MAX_LINES = 500;
/** Owner read/write only. Matches AUDIT_FILE_MODE — the same class of file, the same reason. */
const TELEMETRY_FILE_MODE = 0o600;

function isEnabled(): boolean {
  return readSetting("telemetry_enabled") === "true";
}

function logPath(): string {
  return path.join(app.getPath("userData"), LOG_FILE);
}

/** Append one record to the local log, if telemetry is enabled. Best-effort. */
export function recordTelemetry(input: TelemetryInput): void {
  if (!isEnabled()) return;
  try {
    const rec = buildRecord(input, new Date().toISOString(), app.getVersion());
    const file = logPath();
    /**
     * ── ⚠ 0600, LIKE THE AUDIT LOG ────────────────────────────────────────────────────────────
     *
     * `appendFileSync` creates with 0666 masked by the umask, commonly 0644: group- and world-readable. Crash
     * logs carry stack traces, error messages and request URLs from this user's session, and on a shared or
     * managed machine that made them readable by every other local account.
     *
     * ⚠ THE CHMOD IS NOT REDUNDANT WITH THE MODE. `mode` applies only when the file is CREATED, so
     * a log an earlier build already wrote at 0644 would keep those permissions for ever without it.
     */
    fs.appendFileSync(file, JSON.stringify(rec) + "\n", { encoding: "utf-8", mode: TELEMETRY_FILE_MODE });
    try {
      fs.chmodSync(file, TELEMETRY_FILE_MODE);
    } catch {
      /* Windows has no POSIX mode. */
    }

    // Cheap rotation: trim to the most recent MAX_LINES entries.
    const existing = fs.readFileSync(file, "utf-8");
    const trimmed = trimJsonl(existing, MAX_LINES);
    if (trimmed !== null) {
      // Same mode on the rewrite — rotation is a second chance to widen the permissions.
      fs.writeFileSync(file, trimmed, { encoding: "utf-8", mode: TELEMETRY_FILE_MODE });
      try {
        fs.chmodSync(file, TELEMETRY_FILE_MODE);
      } catch {
        /* not POSIX */
      }
    }
  } catch (err) {
    // Never let telemetry crash the app.
    debugLog("[telemetry] write failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Install process-level crash hooks and the renderer report channel. Hooks are
 * always attached (cheap); they no-op internally when telemetry is disabled, so
 * enabling the toggle takes effect without a restart.
 */
export function setupTelemetry(): void {
  process.on("uncaughtException", (err) => {
    recordTelemetry({ source: "main:uncaughtException", message: err.message, stack: err.stack });
  });
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    recordTelemetry({ source: "main:unhandledRejection", message: err.message, stack: err.stack });
  });

  app.on("web-contents-created", (_e, contents) => {
    contents.on("render-process-gone", (_ev, details) => {
      recordTelemetry({
        source: "main:render-process-gone",
        message: `renderer gone: ${details.reason}`,
        extra: { reason: details.reason, exitCode: details.exitCode },
      });
    });
  });
  app.on("child-process-gone", (_e, details) => {
    recordTelemetry({
      source: "main:child-process-gone",
      message: `child gone: ${details.type} ${details.reason}`,
      extra: { type: details.type, reason: details.reason, exitCode: details.exitCode },
    });
  });

  // Renderer-side errors (window.onerror, unhandledrejection, ErrorBoundary).
  ipcMain.handle("telemetry:report", (_event, payload: TelemetryInput) => {
    recordTelemetry({
      source: payload?.source || "renderer:error",
      message: payload?.message || "unknown renderer error",
      stack: payload?.stack,
      extra: payload?.extra,
    });
    return { ok: true };
  });

  // Let the renderer know the current setting (for UI + gating).
  ipcMain.handle("telemetry:isEnabled", () => ({ enabled: isEnabled() }));

  // Reveal the log file in the OS file manager (from Settings) so a user can
  // find/share it — only meaningful when they've opted in.
  ipcMain.handle("telemetry:openLog", async () => {
    try {
      const file = logPath();
      if (!fs.existsSync(file)) return { ok: false, error: "No telemetry log yet." };
      const { shell } = await import("electron");
      shell.showItemInFolder(file);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/** Broadcast helper (unused by default; kept for a future remote sink). */
export function notifyRenderers(channel: string, data: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, data);
  }
}
