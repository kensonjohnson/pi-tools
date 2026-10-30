# Disposable memory review evaluation

From the project root:

```sh
node --test tests/memory-review-evaluation/evaluate.test.mjs
node tests/memory-review-evaluation/evaluate.mjs
node tests/memory-review-evaluation/evaluate.mjs -- /absolute/path/to/adapter arg1
```

The default is a no-op offline baseline, not a review. An explicit adapter receives the disposable project as its working directory and as `MEMORY_EVALUATION_PROJECT`. It must review and write the three NDJSON files under `.pi/memory`, preserving the memory format. The command is passed as an argv array, without a shell; child output is suppressed. `--show-raw` allows adapter output and prints the complete before and after corpus and unmatched instruction candidates, which may be sensitive. Do not use it in shared logs.

The fixture copies the current working-tree NDJSON files, including uncommitted changes, and working-tree `extensions`, `lib`, `skills`, `tests`, `.github`, and root package/README files. Symlinks, Git metadata, dependencies, runtime indexes, session history, and other `.pi` state are not copied. This limits the available evidence; an adapter needing sessions or other files requires a separately designed fixture. The temporary directory is removed on normal success and handled errors unless `--retain` is explicit. Abrupt termination can leave a `memory-evaluation-*` directory in the OS temp directory. Remove such leftovers manually. No source memory files are modified by the harness.

With `--retain`, the output reports `retainedProject` without printing memory contents. The private 0700 directory contains before files under `.pi/memory/.evaluation-before/` and reviewed files under `.pi/memory/`. Inspect them with a private diff, then remove the entire retained directory manually. The path is also reported after handled adapter failures; an interrupted process may leave it without reporting the path. Retention keeps sensitive memories, source and runtime files on disk. It is not an authorization to apply changes.

The adapter runs with a fresh HOME and TMPDIR and only PATH and LANG inherited by default. Pass selected environment variables explicitly using `--env=NAME`. Credentials and provider configuration are not passed through by default. A real provider requires an explicit wrapper that supplies its own configuration. **This is not a security sandbox:** an adapter can access the network, original files, or other resources using absolute paths, and can leak corpus data. Run only trusted adapters, and obtain approval before sending corpus or source to a provider. The child has no timeout or process-tree enforcement; stop trusted hung adapters manually.

For the opt-in Pi reviewer adapter and its bounded execution settings, see [PI-ADAPTER.md](PI-ADAPTER.md).

## Reading results

`evaluation` is `fail` if any known stale claim remains, `incomplete` if the reviewer is missing or unfinished, coverage is missing or limited, a fixture is absent, or changes need human review, and `pass` only if no such flags exist. `flags` lists all detected problems, including those masked by `fail`. Removal or rewording of a stale claim requires human review, so this fixture ordinarily cannot report `pass` after correcting one; the automated checks alone cannot certify a replacement. A pass would still not prove general correctness. The no-op baseline reports failure when known stale claims are present.

The CLI exits zero for a successfully produced report, even when the evaluation is `fail` or `incomplete`. `--strict` exits 2 for either status; setup and unreadable corpus errors exit 1. A failed adapter is reported as `adapterFailed` and the harness still compares any readable partial output. Never treat exit zero without `--strict` as acceptance.

- `counts` reports net ID-level additions, removals, content changes and category moves. Moves can also be changes. `distinctChanged` counts each added, removed, or modified ID once, including partial changes after failure. It is not a count of operations and misses changes later reverted. These counts do not judge quality.
- `stale` looks for three exact historical claims: the old Brave launch crash, the Puppeteer/Brave backend, and the single-selection unframed picker. `still_present` is a concrete missed correction. `fixture_absent` means the baseline has changed and the check cannot assess that case. `removed_or_reworded_review` is not proof of a correct replacement: inspect the diff against current source, including `extensions/browser-tools/`, and verify that current browser and picker capabilities remain accurate. Historical picker gate observations must not be deleted merely because they mention a picker.
- Every original practice and decision is an instruction candidate. Exact preservation anywhere in the output corpus is counted, including category moves. Anything else needs human semantic review: valid paraphrases and merges are flagged alongside lost or weakened instructions. The count is deliberately conservative and does not prove instruction preservation. Check negation, conditions, scope and user intent. A clean exact count is not a complete correctness guarantee.
- Check additions for unsupported claims, and inspect all substantive changes in a secure diff before accepting a model. Never apply this disposable output directly to actual memories without separate review. Outputs report counts only by default; adapter failures likewise suppress its output.
