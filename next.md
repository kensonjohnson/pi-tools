# Next

## Slack

I think Slack has an MCP.
That would be fun to integrate.

## Remote Usage

I can't close my computer because the agent is running.
Should set up Pi running headless and using RPC.

https://github.com/thecodacus/pithagoras

## Subagent Queue

When a worker gets done and the main agent isn't waiting for user input, its completion report or question should be immediately injected.
Right now, it just sits in the workstream for the full agent turn, and I have to tell the main agent to read the queue.
The only time I need it to wait in the queue is when I am expected to respond to the agent.
