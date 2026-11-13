# Context-Bench: Full-Book Context-Management Benchmark

You are being evaluated on processing a long source, managing context, and producing accurate answers after reading it. Read the entire `book.txt` from beginning to end before answering. Choose a suitable workflow for your environment, but do not create temporary files or scratchpads.

## Source of truth

`book.txt` is a 1778-line Czech science-fiction novel and the sole source of truth. Do not rely on outside knowledge, prior training data, or assumptions. Read the whole book, including its beginning and ending. You may revisit or search the original `book.txt`; retrieval choices are not scored as misconduct.

## Rules

1. Read all of `book.txt` before producing answers.
2. Access only `./book.txt`, `./input/`, and `./output/`.
3. Modify only `./output/`.
4. Do not create temporary, scratch, or intermediate files anywhere. The only files you may create are the four required answer JSON files below.
5. Do not delegate work to subagents.
6. Use the book as evidence. Never fabricate; if a question's premise is unsupported, state that the fact is not present.
7. Read `input/config.json` and every relevant file under `input/questions/`, and follow their instructions.

## Tasks and required outputs

| Task file | Required output |
|---|---|
| `input/questions/single_needles.json` | `output/single_needles.json` — JSON object mapping every id to a concise answer string. The questions are mixed together; use the book to answer each, and explicitly say when a premise is unsupported. For quoted-word completions, reproduce the exact words. |
| `input/questions/multihop.json` | `output/multihop.json` — JSON object mapping each id to an answer string; combine the facts requested across the book. |
| `input/questions/tasks.json` | `output/chapters.json` and `output/characters.json`, following the schemas and criteria in that file. |

For `chapters.json`, the inclusive end line is the last line containing chapter text, not a blank separator. The epilogue ends before `O AUTOROVI`; that author section is not a chapter. For `characters.json`, include named individual people in the story, including legendary/historical people, Primarchs, and individuals described as gods or deified humans. Do not list places or other non-person entities. Exclude names that occur only in the author/publishing matter.

## Completion check

Before finishing, confirm all four answer files exist in `output/` and are valid JSON:

- `single_needles.json`
- `multihop.json`
- `chapters.json`
- `characters.json`

Do not add commentary or evaluator metadata to the answer files. Timing, tool use, context management, and token usage are measured from the session trace; agent-authored telemetry is not required.
