## Sub-Agent Configuration

When delegating tasks to sub-agents:

- Preferred model: gpt-6-luna
- Required reasoning effort: max
- Keep the main agent on its currently selected model.
- Explicitly configure the model and reasoning effort
  when creating each sub-agent.
- Delegate independent tasks only.
- Avoid concurrent edits to the same files.
- The main agent must review and integrate all results.

If the available delegation tool does not support model
overrides or reasoning-effort overrides, report this
limitation. Do not claim Luna Max was used unless verified.