# Search-Record Profile Fixtures

These sanitized fixtures define a lossless grammar for successful `bash` output produced by a safely recognized `rg` or `grep` command segment.

Accepted streams contain only opaque records with exactly one `:<decimal>:` delimiter per physical line and at least one contiguous repeated prefix. The renderer factors adjacent equal prefixes only; it preserves source order and can decode the encoded record body byte-for-byte.

- `standard-rg.txt` — ordinary path/line/content records.
- `counted-pipeline.txt` — a pipeline-added count is part of the opaque prefix, not a filename.
- `noncontiguous.txt` — a later matching prefix remains a separate group.

Rejected fixtures demonstrate ambiguity and mixed output:

- `ambiguous-delimiter.txt` — a suffix contains a second `:<decimal>:` delimiter.
- `prose.txt` — an unstructured status line.
- `blank-line.txt` — a blank physical line.

No fixture contains retained-session output, credentials, private paths, or project-private data.
