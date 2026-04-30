---
name: feature-planning
description: |
  Use when working on multi-session features or architectural changes that require
  planning, phased implementation, and continuity across conversations. Helps create
  implementation plans with clear phases and tasks, track progress via checklists,
  and maintain context across session compactions. Activate for new features, 
  refactoring, or when docs/SESSION_CONTEXT.md exists in the project.
---

# Feature Planning Skill

This skill provides a structured workflow for planning and implementing features across multiple sessions.

## How This Works

The workflow has two distinct phases:

### Phase 0: Planning (Collaborative)

**Your role**: Partner with the user to create the implementation plan

- Explore the codebase together
- Discuss architectural decisions  
- Propose phase breakdowns
- Hash out details through conversation
- Create planning documents collaboratively

**Output**: Solid implementation plan with clear phases and tasks

### Phase 1+: Implementation (Focused)

**Your role**: Execute the plan that was created in Phase 0

- Stay focused on current phase tasks
- Maintain continuity across sessions
- Avoid duplicate work and tangents
- Track progress systematically

**Output**: Working code that follows the plan

---

## Detecting the Mode

First, check if `tmp/SESSION_CONTEXT.md` exists:

- ✅ **Exists** → **Implementation Mode** - follow the checklist
- ❌ **Doesn't exist** → **Planning Mode** - help create the plan

---

## Planning Mode

### When

User wants to add a new feature or make architectural changes.

### Planning Session Flow

1. **Understand the Goal**
   - Ask clarifying questions
   - Understand user's vision
   - Identify constraints and requirements

2. **Explore the Codebase**
   - Read relevant files together
   - Understand current architecture
   - Identify what needs to change

3. **Propose Phases**
   - Break work into logical phases
   - Suggest dependencies between phases
   - Estimate complexity per phase
   - Discuss trade-offs

4. **Iterate on Details**
   - User provides feedback on your proposals
   - Refine phase breakdown
   - Add specific tasks to each phase
   - Identify critical concepts and patterns

5. **Create Planning Documents**
   - Write `tmp/features/[feature-name]-plan.md` with full roadmap
   - Write `tmp/SESSION_CONTEXT.md` with phase checklists
   - Get user approval before proceeding

### Planning is Iterative - Expect Back-and-Forth

**IMPORTANT**: Planning is a **conversation**, not a single prompt-response.

**Typical planning session flow**:

```
You: "Here's my understanding... [questions]"
User: "Actually, we need X not Y"
You: "Got it. Let me adjust... How about this approach?"
User: "Better, but what about edge case Z?"
You: "Good catch. I'll add that to Phase 3. Updated plan: ..."
User: "Perfect, can we split Phase 2 into two phases?"
You: "Absolutely, that makes sense. New breakdown: ..."
User: "Great! Create the docs"
```

**This is NORMAL and EXPECTED**. Keep iterating until:

- ✅ You and the user are completely aligned
- ✅ User explicitly says "looks good" or "create the docs"
- ✅ All major edge cases discussed
- ✅ Phase breakdown feels right to both of you
- ✅ Dependencies are clear
- ✅ Critical concepts identified

**Don't rush to create docs** - the planning conversation IS the work.

### Planning Mode - DOs and DON'Ts

**✅ DO**:

- **Ask lots of questions** - Better to over-clarify than assume
- **Explore codebase together** - Share what you're learning
- **Propose multiple approaches** - If there are trade-offs, discuss them
- **Welcome user feedback** - "Actually..." is a good sign of engagement
- **Iterate freely** - Plans should evolve through discussion
- **Think through edge cases** - "What happens if..." questions
- **Explain your reasoning** - Help user understand why you suggest phases
- **Document "why" decisions** - Future you/user will thank you
- **Get explicit approval** - "Should I create the docs now?"
- **Keep phases high-level** - Don't specify implementation details yet

**❌ DON'T**:

- **Don't rush to produce a plan** - Achieve alignment first
- **Don't implement before plan approved** - Planning ≠ Implementation
- **Don't make assumptions** - Ask instead of guessing
- **Don't create docs on first proposal** - User will want to refine
- **Don't skip edge cases** - "What about..." questions prevent later bugs
- **Don't forget dependencies** - Phase order matters
- **Don't be rigid** - User knows their domain, adapt to feedback
- **Don't hide complexity** - If something is hard, say so
- **Don't commit to implementation details** - High-level phases only
- **Don't provide too much information at once** - Let user respond

---

## Creating Planning Documents

**When user says "Create the planning docs":**

1. **Create directory** (if needed):
   ```bash
   mkdir -p tmp/features
   ```

2. **Create Implementation Plan**:
   - Use the template below
   - Fill in all sections based on planning conversation
   - Include all phases discussed
   - Add critical concepts identified
   - List all files that will be changed

3. **Create Session Context**:
   - Use the template below
   - Extract phase checklists from Implementation Plan
   - Keep critical concepts SHORT (2-4 key points)
   - Add file quick reference for easy navigation

4. **Tell user**:
   ```
   Planning docs created:
   - docs/features/[name]-plan.md (full roadmap)
   - docs/SESSION_CONTEXT.md (session guide)

   Please review these docs. Once approved, we can start Phase 1.
   ```

---

## Implementation Mode

### When

Planning is complete, SESSION_CONTEXT.md exists, user says "start Phase 1" (or similar).

### Implementation Mode Flow

1. **Read SESSION_CONTEXT.md** - Every session start
2. **Determine current phase** - Check phase status
3. **Follow the checklist** - Complete tasks in order
4. **Stay in scope** - Current phase only
5. **Run verification** - Commands at end of phase
6. **Update progress** - Mark checkboxes, add session notes

### Implementation Mode - DOs and DON'Ts

**✅ DO**:

- **Read SESSION_CONTEXT.md first** - Every session
- **Follow the checklist** - Do tasks in order
- **Stay in scope** - Current phase only
- **Mark progress** - Check boxes as you go
- **Run verification** - Commands at end of phase
- **Update session notes** - 2-3 bullets max
- **Ask before expanding scope** - "Should I also refactor X?"

**❌ DON'T**:

- **Don't skip SESSION_CONTEXT.md** - It's your roadmap
- **Don't work on future phases** - Even if you see issues
- **Don't refactor unrelated code** - Stay focused
- **Don't add features not in checklist** - Scope creep
- **Don't write long session notes** - Keep them concise
- **Don't assume context** - If unclear, ask or read referenced docs

---

## Document Hierarchy

### Tier 1: SESSION_CONTEXT.md (Read Every Session)

- **Size**: ~100-200 lines
- **Purpose**: Focus - tells you what to do NOW
- **Location**: `tmp/SESSION_CONTEXT.md`
- **Update**: After every session

### Tier 2: Feature Plan (Reference When Stuck)

- **Size**: ~500-1000 lines
- **Purpose**: Detailed roadmap with all phases
- **Location**: `tmp/features/[feature-name]-plan.md`
- **Update**: After phase completion

---

## When to Read What

### Always Read

- ✅ `tmp/SESSION_CONTEXT.md` - Every session start

### Read When Stuck

- 📖 `tmp/features/[feature-name]-plan.md` - Need more detail on phase
- 📖 Project-specific docs mentioned in SESSION_CONTEXT.md

---

## Session Notes Template

When updating SESSION_CONTEXT.md after completing work, use this format:

```markdown
### Session [N] - [Date]

**Phase**: Phase [N] - [Phase Name]
**Done**:

- [Brief bullet 1]
- [Brief bullet 2]
- [Brief bullet 3 if needed]

**Next**: [What to do next session - usually next phase]
**Blockers**: [Any issues, or "None"]
```

**Good example**:

```markdown
### Session 2 - Dec 10, 2025

**Phase**: Phase 2 - Database Operations
**Done**:

- Created bulk insert service with transaction rollback
- Added duplicate name conflict resolution
- Integration tests passing (5/5)

**Next**: Phase 3 - Upload UI component
**Blockers**: None
```

**Bad example** (too detailed):

```markdown
**Done**:

- Created src/services/material-import.ts with bulkInsertMaterials function
- Function accepts array of MaterialCSVRow objects
- Used database transaction with try/catch for rollback
- Added unique constraint handling for duplicate material names
- Returns success count and error list
- Wrote 5 integration tests covering happy path and error cases
- All tests use test database fixtures from tests/fixtures/
```

❌ Too detailed - just say "Created bulk insert service, tests passing"

---

## Templates

### Template 1: Feature Plan (`tmp/features/[feature-name]-plan.md`)

```markdown
# [Feature Name] - Implementation Plan

**Created**: [Date]
**Status**: Planning / In Progress / Complete

---

## Overview

**Goal**: [1-2 sentence description of what we're building]

**Why**: [Why we need this feature]

**Scope**: [What's included, what's explicitly NOT included]

---

## Phase Breakdown

### Phase 1: [Phase Name] (Session 1)

**Goal**: [What this phase accomplishes]

**Tasks**:

- [ ] Task 1 (file: `path/to/file.ts`)
- [ ] Task 2 (file: `path/to/file.ts`)
- [ ] Task 3
- [ ] Run: [verification command]

**Files Changed**:

- `path/to/file.ts` - [What changes]
- `path/to/other.ts` - [What changes]

**Success Criteria**: [How to know this phase is done]

---

### Phase 2: [Phase Name] (Session 2)

[Same structure as Phase 1]

---

[Repeat for all phases]

---

## Dependencies

```
Phase 1 (Foundation)
↓
Phase 2 (Backend)
↓
Phase 3 (Frontend)
↓
Phase 4 (Polish)
```

**Critical path**: Phase 1 must complete before Phase 2, etc.

---

## Critical Concepts

### 1. [Important Pattern/Concept]

[Explanation with code example if helpful]

### 2. [Another Key Concept]

[Explanation]

---

## Testing Strategy

**Unit Tests**: [What to unit test]
**Integration Tests**: [What to integration test]
**Manual Testing**: [What to test manually]

---

## File Locations

**Backend**:
- `src/[new-file].ts` - [Purpose]
- `src/routes/[updated].ts` - [What updates]

**Frontend**:
- `frontend/src/components/[new].tsx` - [Purpose]

---

## Common Mistakes to Avoid

❌ [Anti-pattern]
✅ [Correct approach]

---

## References

- Link to related API docs
- Link to similar features
```

---

### Template 2: Session Context (`tmp/SESSION_CONTEXT.md`)

```markdown
# Session Context - [Feature Name]

**Last Updated**: [Date]
**Current Phase**: Phase 1 ([Phase Name])
**Status**: 🔄 In Progress

---

## Critical Concepts (Read Every Session)

### 1. [Most Important Pattern]

[Brief explanation or code snippet]

### 2. [Key Architecture Point]

[Brief explanation]

### 3. [Common Mistake to Avoid]

❌ [Wrong way]
✅ [Right way]

---

## Phase Checklist

### Phase 1: [Name] ⬜

- [ ] Task 1
- [ ] Task 2
- [ ] Task 3
- [ ] Run: [verification command]

### Phase 2: [Name] ⬜

- [ ] Task 1
- [ ] Task 2
- [ ] Task 3
- [ ] Run: [verification command]

### Phase 3: [Name] ⬜

[Continue for all phases]

---

## Current Session Progress

### Session 1 - [Date]

**Phase**: Phase 1 - [Name]
**Done**:

- [Bullet 1]
- [Bullet 2]

**Next**: Phase 2 - [Name]
**Blockers**: None

---

## File Quick Reference

**Key Files**:

- `path/to/main.ts` (~line 100) - [What's here]
- `path/to/other.ts` - [What's here]

**Commands**:

- `npm run dev` - Start development
- `npm test` - Run tests
- `npm run typecheck` - Check types

---

## Common Mistakes to Avoid

❌ [Mistake 1]
✅ [Correct approach 1]

❌ [Mistake 2]
✅ [Correct approach 2]

---

**Update This File**: After every session, mark checkboxes and add session notes (2-3 bullets max)
```

---

## Quick Decision Tree

```
User wants new feature/major change
  ↓
Does docs/SESSION_CONTEXT.md exist for this?
  ↓
NO → PLANNING MODE
  ↓
1. Have planning conversation (iterate!)
2. User approves plan
3. Create docs:
   ├─ docs/features/[feature-name]-plan.md (ALWAYS)
   └─ docs/SESSION_CONTEXT.md (ALWAYS)
4. Wait for user approval
5. User says "start Phase 1"
  ↓
YES → IMPLEMENTATION MODE
  ↓
1. Read docs/SESSION_CONTEXT.md
2. Follow current phase checklist
3. Mark progress as you go
4. Update session notes (2-3 bullets)
```

---

## Quick Reference Card

```
┌─────────────────────────────────────────────────────────────┐
│ FEATURE PLANNING - QUICK REFERENCE                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│ PLANNING MODE (No SESSION_CONTEXT.md)                       │
│ 1. DISCUSS   → Understand requirements with user            │
│ 2. EXPLORE   → Read relevant codebase together              │
│ 3. PROPOSE   → Suggest phase breakdown                      │
│ 4. ITERATE   → Refine plan based on feedback                │
│ 5. DOCUMENT  → Create planning docs (get approval!)         │
│                                                              │
│ IMPLEMENTATION MODE (SESSION_CONTEXT.md exists)             │
│ 1. READ      → docs/SESSION_CONTEXT.md                      │
│ 2. FOCUS     → Current phase checklist only                 │
│ 3. EXECUTE   → Complete tasks in order                      │
│ 4. VERIFY    → Run phase verification command               │
│ 5. UPDATE    → Mark checkboxes + add 2-3 bullet notes       │
│                                                              │
│ ✅ DO: Collaborate in planning, stay focused in execution   │
│ ❌ DON'T: Skip planning, implement before approval           │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Critical Rules

### ✅ DO

1. **Read SESSION_CONTEXT.md first** - Every session
2. **Follow the checklist** - Do tasks in order
3. **Stay in scope** - Current phase only
4. **Mark progress** - Check boxes as you go
5. **Run verification** - Commands at end of phase
6. **Update session notes** - 2-3 bullets max
7. **Ask before expanding scope** - "Should I also refactor X?"

### ❌ DON'T

1. **Don't skip SESSION_CONTEXT.md** - It's your roadmap
2. **Don't work on future phases** - Even if you see issues
3. **Don't refactor unrelated code** - Stay focused
4. **Don't add features not in checklist** - Scope creep
5. **Don't write long session notes** - Keep them concise
6. **Don't assume context** - If unclear, ask or read referenced docs
