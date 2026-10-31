# Pi reviewer adapter

This adapter runs the checkout's current `MemoryManager`, `MemoryReviewer`, production tracked-store and result wrappers, `reviewAllMemories`, and Pi model runtime against the harness's marked temporary project. The dispatch guard resets its baseline for each review pass: a provably pre-write unknown target is unresolved, while an error after dispatch is not treated as safe. Confirmed writes remain reported after partial failure. It uses the model's context and output metadata, follows full-review pagination, and restarts the snapshot after mutations. It does not replay sessions. The fixture and evidence limits in README.md still apply.

## Apply adapter

Offline verification:

```sh
node --test tests/memory-review-evaluation/*.test.mjs
```

No provider call happens unless the parent explicitly runs the adapter with a configured model and credentials. Example for an approved Anthropic request, with credentials already in the environment:

```sh
export MEMORY_REVIEW_MODEL='anthropic/your-model-id'
export MEMORY_REVIEW_MAX_CALLS=20 MEMORY_REVIEW_MAX_PASSES=12 MEMORY_REVIEW_TIMEOUT_MS=120000
node tests/memory-review-evaluation/evaluate.mjs \
  --env=MEMORY_REVIEW_MODEL --env=MEMORY_REVIEW_MAX_CALLS \
  --env=MEMORY_REVIEW_MAX_PASSES --env=MEMORY_REVIEW_TIMEOUT_MS \
  --env=ANTHROPIC_API_KEY \
  -- node "$PWD/tests/memory-review-evaluation/pi-reviewer-adapter.mjs"
```

Select the appropriate provider environment variable instead. By default no fallback model, global auth file, custom models.json, or Pi extensions are loaded. Built-in models must be available in the installed Pi catalog. The model receives private memory and selected repository evidence, and provider calls can cost money. The adapter is trusted local code, not an OS sandbox. Explicit env forwarding makes credentials available to it; never put secrets in arguments or share raw logs.

For a user-approved OAuth-backed model such as `openai-codex`, explicitly point Pi at an auth file and forward the path, for example:

```sh
export MEMORY_REVIEW_MODEL='openai-codex/your-model-id'
export MEMORY_REVIEW_AUTH_PATH="$HOME/.pi/agent/auth.json"
node tests/memory-review-evaluation/evaluate.mjs --retain \
  --env=MEMORY_REVIEW_MODEL --env=MEMORY_REVIEW_AUTH_PATH \
  -- node "$PWD/tests/memory-review-evaluation/pi-reviewer-adapter.mjs"
```

The path must be absolute. Pi accesses that file directly, outside the temporary fixture. OAuth refresh or other credential operations may update it; source-memory hash checks do not cover it. Use a private copy if the original must remain untouched. The file can contain credentials for multiple providers, so share only a file appropriate for this process. Do not print or commit it. The path is not included in the sanitized outcome.

If a custom provider or model definition is needed, set the absolute `MEMORY_REVIEW_MODELS_PATH` and add `--env=MEMORY_REVIEW_MODELS_PATH`. Pi reads that file directly, and its configuration may contain secrets, override endpoints, or run credential commands. Use only a trusted configuration and review its behavior before running.

To use Pi's cached model catalog, set an absolute `MEMORY_REVIEW_MODELS_STORE_PATH` to a private copy of `models-store.json`, and forward it with `--env=MEMORY_REVIEW_MODELS_STORE_PATH`. The adapter copies that file again into the disposable runtime, and passes a non-null temporary models configuration path so Pi actually loads the file-backed catalog. If an explicit models configuration is also supplied, Pi uses it with the copied catalog. Do not point at a file being concurrently written. Catalog network refresh remains disabled. All paths are opt-in; an empty or relative path fails the adapter.

For an approved diagnostic run, set `MEMORY_REVIEW_PRIVATE_TRACE=1` and forward it with `--env=MEMORY_REVIEW_PRIVATE_TRACE`. Each successfully parsed model response and its sanitized stage metadata is written only under `.evaluation-runtime/private-trace-*.json`, with a 0700 directory and 0600 files. Each reviewer result and final outcome is also recorded best-effort as `private-review-result-*.json` and `private-final-outcome-*.json` in that directory. These files and responses can contain sensitive project or user data, citations, model rationale, and secrets; do not print or share them. Failed or malformed responses are not captured. Caught model, reviewer, and adapter exceptions are recorded best-effort as `private-error-*.json` with a location and up to 65536 characters of stack or message. Exceptions handled entirely inside the reviewer may not reach these hooks. Error traces can include sensitive text and must not be printed or shared. With `--retain`, inspect these files privately in the reported `.evaluation-runtime` directory, then delete the retained project. Trace write failures are suppressed and do not change the review outcome. Tracing is off by default and does not place response data in the summary. Use `--retain` to inspect the files privately; otherwise the harness deletes the entire fixture on normal completion or handled failure. Abrupt termination can leave sensitive files behind. Remove retained or leftover directories after inspection.

The default limits are 20 model completion calls, 12 review passes, and 120 seconds. Set positive integers using the variables above. Maximums are 1000 calls, 1000 passes, and 3600000 milliseconds. A pass can issue multiple calls; the counter guards each actual completion. The abort deadline is cooperative, not a hard kill or a guarantee that the provider cancels a request. There is no cost or token cap. A request already sent may be billed after cancellation. A pass or call limit can leave the snapshot partially changed, so treat `pending` and `uncertain` as incomplete and do not automatically retry.

`reviewer.diagnostics.stageTotals` aggregates generate attempts, errors and elapsed milliseconds by evidence selection, decision, source assessment, semantic assessment, evidence crosscheck, comparison and other, even after the per-response diagnostic list fills. These are host-side elapsed times, not token usage or billing. They include local work, errors and limit-rejected attempts; provider call counts in `reviewer.calls` are measured separately. Prompt-prefix classification can drift when reviewer prompts change. Check `other` and validate classification before comparing runs. No dollar cost or token estimate is reported; obtain actual billing separately if authorized.

The output includes `reviewer.status` (`done`, `pending`, `unresolved`, `uncertain`, or `error`), completion calls, reviewed pages, confirmed change count, and bounded `coverage` counts and gap reasons. `reviewer.diagnostics` records up to 200 model responses or errors with allowlisted stage labels, evidence-request counts, proposal/action counts, evidence-sufficiency counts, assessment verdicts, and numeric or boolean fragment-page metadata. For each response it includes at most 50 proposals with only action, citation kind, target authority, and booleans for a nonempty citation quote and target ID. Omitted counts show truncation. `reviewOutcomes` and `finalOutcome` provide status and exact-allowlisted host detail codes; unrecognized detail becomes `other`. The diagnostics omit model rationale, source paths, and memory content; even these counts describe the review and should be handled accordingly. Malformed or failed responses may have only a stage and error outcome. When the adapter cannot obtain an outcome, its confirmed change count and coverage are null, not zero. The harness separately compares before and after to expose partial net changes regardless of reviewer outcome. `done` does not prove correctness or complete evidence. Missing, limited, or truncated coverage makes the overall evaluation incomplete, including candidate truncation even if the underlying reviewer reports done. `unresolved` means evidence or authority needs review; `uncertain` can mean a change was made before failure. `error` suppresses exception and provider details. Its optional `errorCode` is a bounded code such as `model_unavailable`, `auth_unavailable`, `model_not_configured`, or `setup_failed`; it is not a provider error message. A limit appears as `reason: limit`, including when a partial mutation makes the outcome uncertain. Results include no raw memories by default. `--show-raw` prints the complete before and after corpus and adapter stdout/stderr, so use it only in a private environment and protect the output. By default the temporary copy is deleted. Use `--retain` to receive a private fixture path and inspect `.pi/memory/.evaluation-before/` against `.pi/memory/` without emitting raw contents in the report. Manually delete the retained directory after review. Never apply its changes blindly. Abrupt termination can leave temp files; see README.md.

The harness checks source NDJSON hashes before and after the run, including failures. A change triggers an error but could be an unrelated concurrent write; the check cannot prevent or undo an external write. The adapter rejects an unmarked directory, mismatched working directory, source checkout, nested checkout, and symlinked memory paths before opening the store. It uses the copied project for repository evidence and storage. It imports code and dependencies from the source checkout without loading the source memory store. Do not execute concurrently with a real memory writer if you need a stable comparison.
