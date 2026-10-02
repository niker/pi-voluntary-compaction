import { createReadStream, existsSync } from "node:fs";
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

export async function estimateReadFileTokens(file: ReadFileRange, signal?: AbortSignal): Promise<number> {
  let codepoints = 0;
  for await (const chunk of selectedFileChunks(file, signal)) {
    for (const _character of chunk) codepoints++;
  }
  return Math.ceil(codepoints / 4);
}

export async function readReadFileFull(file: ReadFileRange, signal?: AbortSignal): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of selectedFileChunks(file, signal)) chunks.push(chunk);
  return chunks.join("");
}

/** Read a text-token page (approximately four Unicode codepoints per token). */
export async function readReadFilePage(
  file: ReadFileRange,
  offset: number,
  take: number,
  signal?: AbortSignal,
): Promise<string> {
  const start = offset * 4;
  const end = (offset + take) * 4;
  let cursor = 0;
  const chunks: string[] = [];
  for await (const chunk of selectedFileChunks(file, signal)) {
    const characters = Array.from(chunk);
    const from = Math.max(0, start - cursor);
    const to = Math.min(characters.length, end - cursor);
    if (to > from) chunks.push(characters.slice(from, to).join(""));
    cursor += characters.length;
    if (cursor >= end) break;
  }
  return chunks.join("");
}
