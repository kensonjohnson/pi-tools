# JSON/JSONL Profile Fixtures

These sanitized fixtures establish the recognition and lexical-preservation contract for the production JSON/JSONL analyzer.

## Accepted

| Fixture                | Shape               | Required compact result                                                                                                                                                     |
| ---------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `formatted-object.txt` | JSON object         | `{"id":42,"message":"hello world","escaped":"quote: \"; slash: \\; newline: \n; unicode-space: \u0020","number":1.00,"negativeZero":-0,"scientific":1e+3,"unicode":"café"}` |
| `duplicate-keys.txt`   | JSON object         | `{"first":1,"first":2,"nested":{"values":[0,1.00,-0]}}`                                                                                                                     |
| `array.txt`            | JSON array          | `[{"name":"one","enabled":true},{"name":"two","enabled":false}]`                                                                                                            |
| `deep-nesting.txt`     | Nested JSON object  | `{"root":{"branch":[{"child":{"leaf":[0,{"enabled":true}]}}]}}`                                                                                                             |
| `records.jsonl`        | three JSONL records | `{"id":1,"message":"first record"}\n[2,3,{"nested":true}]\n{"id":3,"escaped":"\u0020 stays escaped"}`                                                                       |

Accepted fixtures must preserve every non-whitespace JSON token in order. In JSONL, physical record separators remain present; they are not removable JSON grammar whitespace.

## Embedded Regions

The production classifier accepts these line-bounded regions after standalone JSON/JSONL recognition fails. It retains every non-JSON span byte-for-byte and replaces all independently verified regions together.

| Fixture                 | Verified regions | Required rendered content                                                                  |
| ----------------------- | ---------------: | ------------------------------------------------------------------------------------------ |
| `embedded-single.txt`   |                1 | `request completed\n{"id":42,"status":"ok"}\nnext command follows\n`                       |
| `embedded-multiple.txt` |                2 | `first payload:\n{"id":1,"state":"ready"}\nprogress: 50%\n[{"id":2},{"id":3}]\nfinished\n` |
| `wrapped-output.txt`    |                1 | `command completed\n{"id":42}\n`                                                           |
| `blank-record.jsonl`    |                2 | `{"id":1}\n\n{"id":2}\n`                                                                   |
| `mixed-records.jsonl`   |                1 | `{"id":1}\n42\n`                                                                           |

A line-bounded region begins with `{` or `[` after indentation only and must end at the end of its physical line apart from whitespace. Multiple nonoverlapping regions are allowed; nested values belong to their outer parsed region and are not candidates themselves.

## Rejected

- `commented.txt`: JSON comments.
- `primitive.txt`: root primitive.
- `malformed.txt`: invalid trailing comma.

No fixture contains retained-session output or project-private data.
