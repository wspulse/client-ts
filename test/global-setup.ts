/**
 * Vitest global setup: spawns the Go testserver before integration tests.
 *
 * Reads "READY:<port>" from the process stderr to discover the listening port,
 * then writes the URL to a temp file that integration tests read.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_URL_FILE = path.resolve(__dirname, ".server-url");

let serverProc: ChildProcess | null = null;

/**
 * Vitest globalSetup entry point.
 *
 * Spawns the Go testserver, waits for the READY handshake, and returns the
 * teardown function that Vitest calls after all integration tests complete.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const cwd = path.resolve(__dirname, "..", "testserver");

  serverProc = spawn("go", ["run", "."], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const proc = serverProc;

  // Wait for the "READY:<port>" line on stderr (max 30 s).
  const url = await new Promise<string>((resolve, reject) => {
    let settled = false;

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guaranteed non-null after spawn
    const rl = createInterface({ input: proc.stderr! });

    const cleanup = (killProc: boolean, err?: Error, url?: string) => {
      clearTimeout(timeout);
      rl.removeListener("line", onLine);
      rl.close();
      proc.removeListener("error", onError);
      proc.removeListener("exit", onExit);
      if (killProc && !proc.killed) {
        try {
          proc.kill();
        } catch {
          // Ignore — process may have already exited.
        }
      }
      if (err) reject(err);
      else if (url) resolve(url);
    };

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup(true, new Error("testserver did not become ready within 30 s"));
    }, 30_000);

    const onLine = (line: string) => {
      const m = line.match(/READY:(\d+)/);
      if (m && !settled) {
        settled = true;
        cleanup(false, undefined, `ws://127.0.0.1:${m[1]}`);
      }
    };

    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup(true, new Error(`testserver failed to start: ${err.message}`));
    };

    const onExit = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup(
        true,
        new Error(`testserver exited prematurely with code ${code}`),
      );
    };

    rl.on("line", onLine);
    proc.on("error", onError);
    proc.on("exit", onExit);
  });

  // Write URL to a temp file so test workers can read it.
  writeFileSync(SERVER_URL_FILE, url, "utf-8");

  return async function globalTeardown(): Promise<void> {
    // Clean up temp file.
    try {
      unlinkSync(SERVER_URL_FILE);
    } catch {
      // Ignore if already cleaned.
    }

    if (serverProc && !serverProc.killed) {
      serverProc.kill("SIGTERM");
      const proc = serverProc;
      // Wait for exit (max 5 s) to avoid zombie processes.
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          proc.kill("SIGKILL");
          resolve();
        }, 5_000);
        proc.on("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  };
}
