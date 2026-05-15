---
name: research
description: Research assistant for web exploration and persistent note-taking. Use when the user asks to research a topic, explore something online, gather information, or maintain research notes. Activates structured research workflow with web search and persistent markdown memory.
---

# Research

Conduct research on topics by searching the web and gathering information, then maintain persistent notes in the workspace's research directory.

## Memory Structure

All research notes live in `research/` at the project root (create it if it doesn't exist).

- Each topic gets its own `.md` file (e.g., `topic-name.md`)
- Maintain an `index.md` file as a table of contents:

  ```
  | Topic | Summary |
  |-------|---------|
  | [topic-name.md](topic-name.md) | Brief summary |
  ```

## Workflow

1. When a new research topic is discussed, create a dedicated `.md` file in `.pi/research/`
2. Before updating an existing topic, read the current file first
3. Update the `index.md` with new topics and summaries
4. Use `brave_search` for current information, `web_content` for specific URLs

## Guidelines

- Write in clear, concise language
- Cite sources when referencing web findings (include URL)
- Structure notes for future reference with headings, lists, and links
- Only write to `research/` — do not write research notes elsewhere in the repository
- When updating an existing topic, append new findings rather than overwriting unless asked
