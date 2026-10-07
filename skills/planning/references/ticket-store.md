# Ticket store configuration and contract

This reference defines how the planning workflow selects and uses a ticket store. It does not prescribe a product, API, or tool namespace. Follow the selected integration's own instructions for connectivity, authentication, permissions, and safe operations.

## Project configuration

Read the Planning section in the project's applicable `AGENTS.md` instructions. Respect existing instruction precedence; do not replace unrelated project instructions. If inherited sections conflict or the destination is ambiguous, ask before writing records.

This section is a convention interpreted by the planning skill, not a built-in Pi setting. No extension or custom settings parser is required.

### Local store

```markdown
## Planning

- Store: local
- Root: tmp/planning/
```

`Root` is relative to the repository root unless it is an explicit absolute path. For a project without a repository, use the project directory. Default to `tmp/planning/` when a local store omits Root.

If no store is configured, use this local default. Do not treat invalid, incomplete, or unreachable explicit configuration as an absent configuration.

### External store

```markdown
## Planning

- Store: external
- Integration: <configured tool namespace or integration name>
- Initiative: <canonical project or parent-ticket URL>
- Authority: tickets in this store are the source of truth
```

`Integration` identifies an available integration, not credentials or installation instructions. `Initiative` identifies the selected destination or existing initiative container. A project-level destination can contain multiple initiative maps. Resolve the destination through read tools and retain its confirmed stable identifier if a URL alone is insufficient.

Configure mappings only when needed. For example:

```markdown
### Planning mappings

- Initiative map: selected container's description
- Ticket type and mode: Planning metadata section in each ticket
- Ticket status: Planning metadata section in each ticket
- Dependencies: Blocked by section containing canonical ticket links
- Progress: ticket comments
- Operational view: derive from ticket metadata and dependency state
```

This example is not a required mapping. Prefer existing dedicated fields and typed relations when they preserve the workflow's semantics. Do not assume that an integration supports these particular fields or representations.

Credentials belong in the integration's existing secure configuration. Never request or store secrets in `AGENTS.md`, ticket descriptions, comments, or local planning files.

## First-use setup

When the user selects an external store without complete configuration:

1. Discover the available integration and read its usage and safety instructions.
2. Inspect accessible destinations using read tools. Use existing project instructions or a user-supplied destination to narrow the search; ask the user to choose when ambiguous.
3. Inspect how the selected destination represents initiative containers, tickets, statuses, fields, dependencies, and progress. Inspect existing planning records before inventing conventions.
4. Identify a mapping that preserves the logical model. Ask about missing capabilities or ambiguous mappings. Do not create shared statuses, global fields, or labels without approval.
5. With user approval for the destination and mapping, add the Planning section to project instructions. Preserve unrelated content. If instructions cannot be edited, report the limitation and ask where configuration should live.
6. Read back the configuration and selected destination before creating planning records. Verify each mutation through the integration's returned record or a follow-up read.

Configuration setup does not authorize ticket migration, deletion, or starting implementation. Honor the planning workflow's separate review and execution handoffs.

## Required storage contract

A store must preserve the following information, either natively or in consistent structured text:

| Record | Required information |
|---|---|
| Initiative map | Stable identity; destination; included and excluded scope; decisions; unresolved areas; links to its tickets |
| Ticket | Stable identity; initiative membership; title; type; status; mode; dependencies; objective; relevant context; acceptance criteria; resolution; progress |
| Implementation ticket | Concrete approach; affected areas when useful; verification commands or a documented manual check |
| Dependency | Explicit direction and stable identifiers for both tickets |
| Operational view | Ready, blocked, and active work derived from canonical tickets and dependency completion |

The store must allow the agent to read and update the required records through available authorized tools. Creating new tickets also requires a supported create operation. Do not claim that a read-only store can carry execution updates.

Preserve the logical values defined in `SKILL.md`:

- Type: `decision`, `research`, `prototype`, `task`, `implementation`.
- Status: `open`, `active`, `resolved`, `done`, `cancelled`.
- Mode: `hitl`, `afk`.
- Dependencies: `blocked_by` references to stable ticket identifiers.
- Phase: optional grouping, never an implicit dependency.

If native statuses collapse distinctions such as `resolved` and `done`, retain the logical status in explicit metadata or use a documented unambiguous mapping based on ticket type. Native display state must not become a competing authority.

If there is no native dependency relation, use a structured Blocked by section with confirmed canonical links or IDs. Do not replace dependencies with vague prose, tags, or ordering. Define direction explicitly: a ticket's `blocked_by` list names its prerequisites. If links cannot be resolved, the ticket is not ready.

A map can live in a container description, a dedicated planning record, or another supported record within the selected store. Its ticket index and operational lists may be derived from queries rather than independently persisted. Destination, scope, decisions, and unresolved areas must remain durable and discoverable.

## Reading and updating work

- Fetch current records before consequential changes. Read relationships in the integration's supported form and observe pagination or result limits.
- Treat references in examples as placeholders, never usable IDs. Resolve identifiers from actual store reads or confirmed creation results.
- Before starting work, verify the ticket is open and its blockers are complete, then claim it as active. Use conditional updates when supported; do not imply that a read-then-write claim is atomic.
- Update only the intended fields. Preserve unrelated descriptions, labels, links, assignees, and comments.
- Verify creation, status changes, dependency links, and resolutions. If a request has an uncertain outcome, read the store before retrying to avoid duplicate records.
- Refresh stored map summaries from canonical tickets. Do not independently maintain readiness in a board column when dependencies say otherwise.

## Local Markdown layout

```text
<root>/<initiative-slug>/
├── map.md
└── tickets/
    ├── 01-<slug>.md
    ├── 02-<slug>.md
    └── ...
```

Use the ticket and map formats in `SKILL.md`. Use zero-padded sequential ticket numbers as stable identifiers within an initiative, and qualified paths when referencing another initiative. Do not reuse a number. Refer to tickets by their linked title in prose.

Inspect `<root>/*/map.md` before creating an initiative. Local files are repository-local working artifacts by default, not committed documentation; do not commit the ticket archive unless requested.

## Authority and failure handling

There is one authoritative store per configured planning scope. Project configuration may record the destination, mappings, and pointers, but must not duplicate canonical ticket descriptions, statuses, or progress.

Do not maintain local ticket copies alongside external canonical tickets. Temporary exports are acceptable for an explicit operation, but must be marked non-authoritative and never become the normal execution record.

If the configured store is unreachable, lacks permissions, or cannot preserve required semantics, report the specific blocker and ask how to proceed. Never silently create local tickets, choose a different external destination, or mark an unverified write successful.

## Changing stores

Changing configuration alone does not migrate existing initiatives. Obtain explicit approval before moving planning records:

1. Read the source initiative map, tickets, dependencies, decisions, and progress.
2. Agree on the destination and field mapping; preserve completed and cancelled work needed to interpret the initiative.
3. Create destination records and build a source-to-destination ID map. Add dependencies after destination IDs are known.
4. Verify transferred content, membership, logical statuses, and dependency direction. If migration fails partway, retain the source as authoritative and report partial destination records before retrying.
5. Only after verification, update project configuration and mark the source records as superseded with canonical destination links.

Do not delete source records without a separate authorized deletion workflow. Preserve the ability to trace old references while keeping only the destination active for further work.
