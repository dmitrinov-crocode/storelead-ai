"use server";

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { revalidatePath } from "next/cache";
import { activeLock, writeLock } from "./pipelineLock";
import {
  buildPipelineCommand,
  InvalidCommandError,
  logFileName,
  parseAction,
} from "./runCommand";
import { decide } from "./emailWrites";
import { EmailTransitionError, isHumanDecision } from "@core/pipeline/emailTransitions";

export interface ActionResult {
  ok: boolean;
  message: string;
}

const WORKSPACE_ROOT = process.env.STORELEAD_ROOT;

/**
 * Starts a pipeline command as a detached child process.
 *
 * The dashboard does not import the pipeline: a run takes seconds today and
 * minutes once Playwright lands, which is far too long to hold a request open,
 * and running it inside the Next server would tie the pipeline's lifetime to
 * the UI. Spawning the same CLI the user runs by hand keeps one code path.
 */
export async function startPipeline(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    if (!WORKSPACE_ROOT) {
      return { ok: false, message: "STORELEAD_ROOT is not set — restart the dev server." };
    }

    const action = parseAction(formData.get("action"));
    const command = buildPipelineCommand(action, formData.get("limit"));

    // One pipeline at a time: two concurrent runs would interleave on the same
    // batch cursor and fetch overlapping stores. The lock covers runs started
    // from the terminal too, since the CLI claims it as well.
    const dataDir = path.join(WORKSPACE_ROOT, "data");
    mkdirSync(dataDir, { recursive: true });

    const held = activeLock(dataDir);
    if (held) {
      return { ok: false, message: `${held.label} is still going (pid ${held.pid}) — wait for it.` };
    }

    const tsx = path.join(WORKSPACE_ROOT, "node_modules", ".bin", "tsx");
    if (!existsSync(tsx)) {
      return { ok: false, message: "tsx not found — run `npm install` in the project root." };
    }

    const logDir = path.join(dataDir, "logs");
    mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, logFileName(action));
    const log = openSync(logPath, "a");

    const child = spawn(tsx, ["src/cli/index.ts", ...command.args], {
      cwd: WORKSPACE_ROOT,
      // No shell: argv is passed through verbatim, so nothing is ever interpreted.
      shell: false,
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, LOG_PRETTY: "false" },
    });
    // Let the run outlive the request that started it.
    child.unref();

    if (child.pid !== undefined) {
      writeLock(dataDir, {
        pid: child.pid,
        startedAt: new Date().toISOString(),
        label: command.label,
      });
    }

    revalidatePath("/");
    return {
      ok: true,
      message: `${command.label} — started as pid ${child.pid ?? "?"}. Output: data/logs/${path.basename(logPath)}`,
    };
  } catch (error) {
    if (error instanceof InvalidCommandError) return { ok: false, message: error.message };
    return { ok: false, message: `Could not start: ${(error as Error).message}` };
  }
}

/** Re-reads the database so the page reflects a run that is in progress. */
export async function refresh(): Promise<void> {
  revalidatePath("/");
}

// ------------------------------------------------- outreach decisions (6-08)

/**
 * Approve or skip one draft.
 *
 * This is the one place the dashboard writes. Everything else reads through a
 * read-only handle on purpose, and the exception is deliberate rather than a
 * loosening: the guard that decides which transitions are legal lives in
 * `setEmailStatus`, and re-implementing it here would put the rule that stops an
 * unchecked letter being approved in two places, where it can drift.
 */
export async function decideEmail(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const id = Number(formData.get("emailId"));
  const decision = formData.get("decision");

  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, message: "That draft has no id — reload the page." };
  }
  if (!isHumanDecision(decision)) {
    return { ok: false, message: `Unknown decision: ${String(decision)}` };
  }

  try {
    const row = decide(id, decision);
    revalidatePath(`/stores/${row.storeId}`);
    revalidatePath("/");
    return {
      ok: true,
      message: decision === "APPROVED" ? "Approved — ready to send by hand." : "Skipped.",
    };
  } catch (error) {
    if (error instanceof EmailTransitionError) return { ok: false, message: error.message };
    return { ok: false, message: `Could not save: ${(error as Error).message}` };
  }
}

/**
 * Regenerates one letter by running the outreach step for that store alone.
 *
 * Spawned as the CLI, like every other pipeline work the UI starts: a letter
 * takes a minute or two of model calls, far too long to hold a request open.
 * `--store` keeps it to this shop, and `--force` is what makes it redo a draft
 * the step would otherwise consider done.
 */
export async function regenerateEmail(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  if (!WORKSPACE_ROOT) {
    return { ok: false, message: "STORELEAD_ROOT is not set — restart the dev server." };
  }

  const domain = String(formData.get("domain") ?? "").trim();
  const runId = Number(formData.get("runId"));
  const storeId = Number(formData.get("storeId"));
  if (domain === "" || !Number.isInteger(runId) || runId <= 0) {
    return { ok: false, message: "This store has no run to attribute the work to." };
  }

  const dataDir = path.join(WORKSPACE_ROOT, "data");
  const held = activeLock(dataDir);
  if (held) {
    return { ok: false, message: `${held.label} is still going (pid ${held.pid}) — wait for it.` };
  }

  const tsx = path.join(WORKSPACE_ROOT, "node_modules", ".bin", "tsx");
  if (!existsSync(tsx)) {
    return { ok: false, message: "tsx not found — run `npm install` in the project root." };
  }

  const logDir = path.join(dataDir, "logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, logFileName("run"));
  const log = openSync(logPath, "a");

  const child = spawn(
    tsx,
    [
      "src/cli/index.ts",
      "step",
      "email_generation",
      "--run",
      String(runId),
      "--store",
      domain,
      "--force",
    ],
    {
      cwd: WORKSPACE_ROOT,
      shell: false,
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, LOG_PRETTY: "false" },
    },
  );
  child.unref();

  if (child.pid !== undefined) {
    writeLock(dataDir, {
      pid: child.pid,
      startedAt: new Date().toISOString(),
      label: `Rewriting the letter for ${domain}`,
    });
  }

  revalidatePath(`/stores/${storeId}`);
  return { ok: true, message: `Rewriting the letter for ${domain} — this takes a minute or two.` };
}
