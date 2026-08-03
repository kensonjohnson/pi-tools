---
name: planning
description: Plan and carry multi-session work from either an unclear initiative or a settled goal through detailed, dependency-linked Markdown tickets and focused execution. Use for features, refactors, migrations, and architectural changes that need scope control or coordination across sessions.
---

# Planning

Planning is the durable system for work that cannot be safely completed from a short conversation. It replaces phase-based feature planning with an initiative map and dependency-linked Markdown tickets.

A ticket is the unit of thought and execution. It gives every discovered item an explicit home, so it cannot disappear into chat history, a vague phase, or session notes.

Planning includes implementation detail. For an unclear initiative, it first resolves unknowns, then creates implementation tickets only when their work is concrete enough to execute. For a clear initiative, it creates those implementation tickets directly. It does not stop at a high-level plan.

## Core model

- **Initiative**: one bounded body of work with a destination.
- **Map**: low-resolution index for an initiative: destination, scope, fog, ticket links, decisions, and frontier.
- **Ticket**: one durable Markdown file that owns a question, research task, prototype, unblocking task, or independently verifiable implementation slice.
- **Fog**: an in-scope area that is not yet precise enough to become a ticket.
- **Frontier**: open, unclaimed tickets whose blockers are complete. This is the only pool from which work should normally be taken.
- **Dependency**: a real prerequisite, not merely a preferred ordering.

Keep work types distinct:

- **Decision**: a question the user must settle. Never answer a user preference, product choice, or business trade-off on the user's behalf.
- **Research**: an AFK fact-finding task; use authoritative sources and record citations.
- **Prototype**: a cheap artifact used to make a decision concrete; resolve it with the user.
- **Task**: narrow work that unblocks a later decision or implementation ticket.
- **Implementation**: a self-contained, verifiable change. It can include implementation approach, files/areas, tests, acceptance criteria, and verification commands.

Do not use tickets as renamed horizontal phases. Prefer a narrow vertical slice that produces observable behaviour. A broad mechanical refactor is an exception: use expand → migrate in green batches → contract.

## Storage

Planning artifacts are repository-local working files, not committed documentation:

```text
tmp/planning/<initiative-slug>/
├── map.md
└── tickets/
    ├── 01-<slug>.md
    ├── 02-<slug>.md
    └── ...
```

Use zero-padded sequential numbers. Numbers are stable identifiers; refer to tickets by their linked title in prose. Do not reuse a number.

Before creating a new initiative, check `tmp/planning/*/map.md`:

- If one active map matches the work, resume it.
- If several active maps exist and the request does not identify one, show them and ask which to use.
- If no map applies, create one only after the destination and initial frontier are understood.

The map is the navigational index. A ticket is canonical for its own detail, status, resolution, and progress. Never duplicate a resolution in full on the map; link and summarize it in one line.

These files are the working record only while an initiative is active. Git commits are the durable record of completed implementation. Create or update committed ADRs, release notes, or other documentation only when the user asks to preserve a high-level decision or lesson; never commit the ticket archive by default.

## Ticket format

Every ticket has this frontmatter and the sections appropriate to its type:

```markdown
---
type: decision | research | prototype | task | implementation
status: open | active | resolved | done | cancelled
mode: hitl | afk
blocked_by: []
phase: optional-grouping
---

# Ticket title

## Objective

<!-- Question to settle, fact to establish, or user-visible outcome to deliver. -->

## Context

<!-- Links to related tickets, code/docs, constraints, and why this is needed. -->

## Approach

<!-- Required for implementation tickets once known; include relevant areas/files only when useful. -->

## Acceptance criteria

- [ ] Observable criterion
- [ ] Verification: `command` or documented manual check

## Resolution

<!-- For decisions/research/prototypes/tasks: answer, evidence, links, and consequences. -->

## Progress

<!-- Append concise session entries while active: done, verification, next action, blocker. -->
```

Rules:

- `status: open` can be on the frontier or blocked; derive blocked state from `blocked_by` rather than maintaining a second status.
- A blocker is complete when its decision/research/prototype is `resolved`, or its task/implementation ticket is `done`.
- Set `status: active` before beginning substantive work. This is the claim and prevents concurrent sessions taking the same ticket.
- A decision, research, or prototype ticket is `resolved`; task and implementation tickets are `done` only after their acceptance criteria and verification are complete.
- A cancelled ticket must state why in `## Resolution`, then be recorded under map out-of-scope or superseded work.
- Keep progress entries short. The current ticket's `## Progress` replaces a separate per-session log.

## Map format

```markdown
# <Initiative title>

## Destination

<!-- Outcome that marks this initiative complete. -->

## Scope

### Included

- ...

### Out of scope

- ...

## Frontier

- [Ticket title](tickets/01-example.md) — decision — open

## Blocked

- [Ticket title](tickets/02-example.md) — blocked by [Ticket title](tickets/01-example.md)

## Active

- None

## Decisions

- [Ticket title](tickets/01-example.md) — one-line resolved conclusion

## Not yet specified

- In-scope area/question that cannot yet be stated precisely.

## Ticket index

| Ticket                                | Type     | Status | Blocked by |
| ------------------------------------- | -------- | ------ | ---------- |
| [Ticket title](tickets/01-example.md) | decision | open   | —          |
```

Update the map whenever a ticket is created, claimed, resolved/completed, cancelled, or unblocked. The Ticket index provides complete coverage; Frontier, Blocked, and Active are the concise operational view.

## Start an initiative

Use this for any work expected to span sessions or that benefits from explicit scope, dependencies, and tickets. Select the entry mode from the state of the work; both modes produce the same map and ticket graph.

### Discovery mode: route is unclear

1. **Establish destination first.** Ask one decision at a time. State the intended outcome, included scope, and explicit exclusions before decomposing work.
2. **Explore known facts.** Read relevant code and docs. Research facts rather than asking the user for information the repository or authoritative sources can answer.
3. **Map breadth before depth.** Surface the major decision areas, constraints, investigations, and likely implementation seams. Do not produce a phase plan yet.
4. **Classify each discovered item.** Create a ticket only when its objective/question can be stated precisely now. Record the rest under Not yet specified; it is fog, not an incomplete ticket.
5. **Create and wire tickets.** Write all initial ticket files, then add `blocked_by` edges after their numbers are known. Tickets with no unfinished blockers are the initial frontier.
6. **Stop after charting.** Present the map and frontier. Do not silently begin resolving a discovery ticket in the same charting pass.

### Delivery-planning mode: route is clear

1. **Establish destination and scope.** Confirm the outcome and exclusions; do not reopen decisions already settled by the user.
2. **Explore implementation facts.** Read the relevant code and docs, identify seams, prefactoring, tests, and real constraints.
3. **Draft implementation tickets.** Create bounded, independently verifiable slices with concrete approach, acceptance criteria, verification, and only genuine blockers.
4. **Review the graph with the user.** Check ticket granularity, dependency edges, scope, and anything still uncertain. Create discovery tickets only for unresolved questions that materially block implementation.
5. **Publish the map and tickets.** Wire dependencies, identify the frontier, and stop. Do not silently begin the first ticket in the planning pass.

For a small but explicitly planned effort, create one implementation ticket rather than reverting to an untracked checklist. For an obviously one-shot request, work directly unless the user asks to plan it.

## Work an existing initiative

1. Read `map.md`, then the selected active or frontier ticket. Load other ticket detail only when it affects this ticket.
2. If no ticket was named, select the first frontier ticket in map order. Tell the user which ticket is being taken.
3. Claim it by setting `status: active` before substantive work.
4. Resolve or complete exactly one non-research ticket per session unless the user explicitly requests otherwise. Research may run in parallel only when subagents are available; otherwise treat it as a normal AFK ticket.
5. Record the result in the ticket, complete its criteria, and set its terminal status.
6. Update the map: move it from Active/Frontier, add its one-line decision summary if relevant, recompute the frontier, and add newly precise tickets. Remove graduated items from Not yet specified.
7. If new work lies outside the destination, cancel or omit it and record it under Out of scope. Do not let scope expansion masquerade as a dependency.

## From discovery to implementation

A resolved decision may make implementation work precise. At that point create implementation tickets in the same initiative; do not wait to write a separate phase plan.

Before an implementation ticket enters the frontier, ensure it has:

- a bounded, user-observable outcome;
- a concrete approach and relevant implementation areas;
- explicit acceptance criteria;
- a verification command or manual verification procedure;
- only genuine blockers; and
- links to decisions/research that constrain it.

Implementation tickets can be grouped with optional `phase` metadata for readability, but execution follows dependencies and the frontier, not phase order.

## Existing workflow migration

When a repository has `tmp/SESSION_CONTEXT.md`, `docs/SESSION_CONTEXT.md`, or a feature plan from the prior workflow:

1. Read it; do not overwrite or discard it.
2. With the user's approval, create an initiative map under `tmp/planning/` and convert each still-relevant phase or task into dependency-linked implementation tickets.
3. Preserve important decisions, constraints, verification commands, and incomplete work in the relevant tickets.
4. Mark the old working plan as superseded with a link to the map. Do not maintain both systems as live sources of truth.

## Guardrails

- Planning is collaborative: ask user-owned decisions one at a time and offer a recommendation where useful.
- Facts belong in research or code exploration; do not turn easily discoverable facts into user questions.
- Do not create a ticket merely because work is anticipated. Precision, not certainty, is the threshold.
- Do not implement work blocked by an unresolved decision without explicit user direction.
- Do not add unrelated fixes to the current ticket; create a ticket or record it as fog/out of scope.
- Update the Markdown artifacts as work changes. Chat history is never the system of record.
