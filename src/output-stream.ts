import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ReadFileRange = {
  path: string;
  /** Zero-based starting line, matching the read tool's 1-based offset. */
  startLine: number;
  /** Optional number of selected lines, matching the read tool's limit. */
  lineLimit?: number;
};

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
// Conservative preflight estimate.
// Pi does not expose the provider's tokenizer, so keep extra headroom here.
const ESTIMATED_CHARACTERS_PER_TOKEN = 2.0;

export function estimateLineTokens(line: string): number {
  return Math.ceil((Array.from(line).length + 1) / ESTIMATED_CHARACTERS_PER_TOKEN);
}

/** Resolve the local path using the same common expansions as Pi's read tool. */
export function resolveReadSourcePath(input: string, cwd: string): string {
  let normalized = input.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") normalized = homedir();
  else if (normalized.startsWith("~/")) normalized = join(homedir(), normalized.slice(2));
  if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized);
  const absolutePath = isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
  const variants = [
    absolutePath,
    absolutePath.replace(/ (AM|PM)\./gi, "\u202F$1."),
    absolutePath.normalize("NFD"),
    absolutePath.replace(/'/g, "\u2019"),
    absolutePath.normalize("NFD").replace(/'/g, "\u2019"),
  ];
  return variants.find((candidate) => existsSync(candidate)) ?? absolutePath;
}

/** Stream the requested line range without holding the full file in memory. */
async function* selectedFileChunks(file: ReadFileRange, signal?: AbortSignal): AsyncGenerator<string> {
  if (file.lineLimit !== undefined && file.lineLimit <= 0) return;
  const stream = createReadStream(file.path, {
    encoding: "utf8",
    ...(signal ? { signal } : {}),
  });
  let line = 0;
  let started = file.startLine <= 0;
  let includedSeparators = 0;
  let done = false;
  try {
    for await (const rawChunk of stream) {
      const output: string[] = [];
      for (const character of rawChunk as string) {
        if (!started) {
          if (character === "\n") {
            line++;
            if (line >= file.startLine) started = true;
          }
          continue;
        }
        if (character === "\n" && file.lineLimit !== undefined) {
          // Array.slice(start, start + limit).join("\n") omits the newline
          // after the last selected line.
          if (includedSeparators + 1 >= file.lineLimit) {
            done = true;
            break;
          }
          includedSeparators++;
        }
        output.push(character);
      }
      if (output.length) yield output.join("");
      if (done) break;
    }
  } finally {
    stream.destroy();
  }
}

async function* selectedFileLines(file: ReadFileRange, signal?: AbortSignal): AsyncGenerator<string> {
  const input = createReadStream(file.path, {
    encoding: "utf8",
    ...(signal ? { signal } : {}),
  });
  const reader = createInterface({ input, crlfDelay: Infinity });
  let line = 0;
  let emitted = 0;
  try {
    for await (const text of reader) {
      if (line >= file.startLine) {
        if (file.lineLimit !== undefined && emitted >= file.lineLimit) break;
        yield text;
        emitted++;
      }
      line++;
    }
  } finally {
    reader.close();
    input.destroy();
  }
}

export async function estimateReadFileStats(
  file: ReadFileRange,
  signal?: AbortSignal,
): Promise<{ estimatedTokens: number; lineCount: number }> {
  let estimatedTokens = 0;
  let lineCount = 0;
  for await (const line of selectedFileLines(file, signal)) {
    estimatedTokens += estimateLineTokens(line);
    lineCount++;
  }
  return { estimatedTokens, lineCount };
}

export async function countReadFileLinesWithinTokenBudget(
  file: ReadFileRange,
  offset: number,
  tokenBudget: number,
  signal?: AbortSignal,
): Promise<number> {
  if (tokenBudget <= 0) return 0;
  const page = readReadFilePageRange(file, offset, Number.MAX_SAFE_INTEGER);
  let usedTokens = 0;
  let lines = 0;
  for await (const line of selectedFileLines(page, signal)) {
    const lineTokens = estimateLineTokens(line);
    if (usedTokens + lineTokens > tokenBudget) break;
    usedTokens += lineTokens;
    lines++;
  }
  return lines;
}

export function readReadFilePageRange(file: ReadFileRange, offset: number, limit: number): ReadFileRange {
  const lineOffset = Math.max(0, Math.floor(offset) - 1);
  const remainingLines = file.lineLimit === undefined ? limit : Math.max(0, file.lineLimit - lineOffset);
  return {
    path: file.path,
    startLine: file.startLine + lineOffset,
    lineLimit: Math.min(limit, remainingLines),
  };
}

export async function readReadFileFull(file: ReadFileRange, signal?: AbortSignal): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of selectedFileChunks(file, signal)) chunks.push(chunk);
  return chunks.join("");
}
