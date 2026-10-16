/**
 * Replacement for Pi's built-in `bash` tool with no output limit.
 *
 * Pi's shell tool streams command output through a bounded accumulator and
 * returns only the last 2,000 lines / 50 KB, appending a footer that names a
 * temp file holding the complete output. Voluntary compaction intercepts and
 * paginates tool output against the live workspace, so that hard limit is both
 * redundant and lossy: it discards content the pagination pipeline could have
 * served in pages.
 *
 * This module reuses Pi's own shell tool definition unchanged - execution,
 * timeouts, abort handling, PI_* environment, spawn hooks, settings shell
 * path, streaming TUI updates and renderers - and only rewrites the final
 * model-visible text: when Pi truncated the result, the complete output is
 * reopened from the accumulator's temp file. The tool definition is registered
 * under the built-in name, which replaces it entirely.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { CONFIG_DIR_NAME, createBashToolDefinition, getAgentDir } from "@earendil-works/pi-coding-agent";

/** Safety cap for reopening the accumulator temp file; larger output keeps Pi's tail plus temp path. */
const MAX_FULL_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Status lines that Pi appends after the command output. */
const STATUS_SUFFIX = /\n\n(Command exited with code -?\d+|Command terminated without an exit code|Command aborted|Command timed out after [\d.]+ seconds)$/;

const BASH_DESCRIPTION = "Execute a bash command in the current working directory. Returns stdout and stderr. Output is not truncated; oversized output is intercepted by voluntary compaction and paginated. Optionally provide a timeout in seconds.";

type ContentPart = { type: string; text?: string };
type ShellResult = { content: ContentPart[]; details?: any; structuredContent?: unknown; isError?: boolean };
type ShellToolDefinition = ReturnType<typeof createBashToolDefinition>;
type ExecuteArgs = Parameters<ShellToolDefinition["execute"]>;

function statusSuffix(text: string): string | null {
  const match = STATUS_SUFFIX.exec(text);
  return match ? match[1] : null;
}

/** Read the complete command output from the accumulator temp file, or null when unavailable. */
async function readFullOutput(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_FULL_OUTPUT_BYTES) return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function joinedText(result: ShellResult): string {
  return result.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

/** Replace Pi's truncated tail with the complete output, preserving any trailing status line. */
function expandText(truncatedText: string, fullText: string): string {
  const status = statusSuffix(truncatedText);
  const body = fullText.length ? fullText : "(no output)";
  return status ? `${body}\n\n${status}` : body;
}

/** Drop the truncation marker so the TUI renderer does not report a limit, keep the temp path hint. */
function expandedDetails(details: any): any {
  if (!details) return undefined;
  const { truncation: _truncation, ...rest } = details;
  return rest;
}

export type UnlimitedBashOptions = NonNullable<Parameters<typeof createBashToolDefinition>[1]>;

function expandTilde(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/**
 * Read the shell settings Pi feeds to the built-in tool, project over global.
 * Extensions get no settings API, so read the same two files Pi merges. Any
 * unreadable or malformed file is skipped, leaving Pi's own defaults in place.
 */
function readShellSettings(cwd: string): Pick<UnlimitedBashOptions, "commandPrefix" | "shellPath"> {
  const settings: Pick<UnlimitedBashOptions, "commandPrefix" | "shellPath"> = {};
  const paths: string[] = [];
  try {
    paths.push(join(getAgentDir(), "settings.json"), join(cwd, CONFIG_DIR_NAME, "settings.json"));
  } catch {
    return settings;
  }
  for (const path of paths) {
    try {
      if (!existsSync(path)) continue;
      const raw = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
      if (!raw || typeof raw !== "object") continue;
      const prefix = (raw as Record<string, unknown>).shellCommandPrefix;
      const shell = (raw as Record<string, unknown>).shellPath;
      if (typeof prefix === "string" && prefix) settings.commandPrefix = prefix;
      if (typeof shell === "string" && shell) settings.shellPath = expandTilde(shell);
    } catch {
      // Ignore malformed settings; Pi reports those itself.
    }
  }
  return settings;
}

/** Build the `bash` tool definition with unbounded model-visible output. */
export function createUnlimitedBashToolDefinition(cwd: string, options?: UnlimitedBashOptions): ShellToolDefinition {
  const base = createBashToolDefinition(cwd, { ...readShellSettings(cwd), ...options });
  return {
    ...base,
    description: BASH_DESCRIPTION,
    async execute(...args: ExecuteArgs) {
      const [toolCallId, params, signal, onUpdate, ctx] = args;

      // Streaming snapshots carry the temp path once the accumulator spills,
      // which is the only way to recover the full output when Pi signals an
      // abort or timeout by throwing.
      let spilledPath: string | undefined;
      const captureUpdate = (update: any) => {
        const path = update?.details?.fullOutputPath;
        if (typeof path === "string" && path) spilledPath = path;
        onUpdate?.(update);
      };

      let result: ShellResult | undefined;
      let failure: unknown;
      try {
        result = await base.execute(toolCallId, params, signal, captureUpdate as any, ctx) as ShellResult;
      } catch (error) {
        failure = error;
      }

      const details = result?.details;
      const path = details?.fullOutputPath ?? details?.full_output_path ?? spilledPath;
      if (!path) {
        if (failure) throw failure;
        return result as any;
      }
      const fullText = await readFullOutput(path);
      if (fullText === null) {
        if (failure) throw failure;
        return result as any;
      }

      if (failure) {
        // Pi composes abort/timeout messages as `${output}\n\n${status}`.
        const message = failure instanceof Error ? failure.message : String(failure);
        const status = statusSuffix(message);
        const rebuilt = status ? expandText(message, fullText) : message;
        if (failure instanceof Error && failure.message === message) throw new Error(rebuilt);
        throw failure;
      }

      const expanded = expandText(joinedText(result as ShellResult), fullText);
      return {
        ...result,
        content: [{ type: "text", text: expanded }],
        details: expandedDetails(details),
      } as any;
    },
  };
}
