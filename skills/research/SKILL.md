---
name: research
description: Research assistant for web exploration and persistent note-taking. Use when the user asks to research a topic, explore something online, gather information, or maintain research notes. Activates structured research workflow with web search and persistent markdown memory.
---

# Research

Conduct research on topics by searching the web and gathering information, then maintain persistent notes in the workspace's temporary research directory by default.

## Memory Structure

Unless the user explicitly specifies a destination, store all research notes in `tmp/research/` (create it if it does not exist). When the user specifies a location, use that location instead.

- Each topic gets its own `.md` file (e.g., `topic-name.md`)
- Maintain an `index.md` file in the same destination as a table of contents:

  ```
  | Topic | Summary |
  |-------|---------|
  | [topic-name.md](topic-name.md) | Brief summary |
  ```

## Workflow

1. When a new research topic is discussed, create a dedicated `.md` file in `tmp/research/` unless the user specifies another destination
2. Before updating an existing topic, read the current file first
3. Update the destination's `index.md` with new topics and summaries
4. Use `brave_search` for current information, `web_content` for specific URLs

## Guidelines

- Write in clear, concise language
- Cite sources when referencing web findings (include URL)
- Structure notes for future reference with headings, lists, and links
- Default to `tmp/research/`; honor an explicitly requested destination
- When updating an existing topic, append new findings rather than overwriting unless asked
