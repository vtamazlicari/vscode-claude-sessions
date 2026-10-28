# Claude Sessions

Adds a **Sessions** list to Claude Code's side bar in VS Code: one row per running chat, click to switch, × to stop it, + for a new chat.

macOS/Linux only (uses `ps`). Needs `"claudeCode.preferredLocation": "sidebar"` in VS Code settings.

## Install

```bash
gh release download --repo vtamazlicari/vscode-claude-sessions --pattern '*.vsix'
code --install-extension claude-sessions.vsix --force
```

Then reload the window.

## Build

```bash
npx @vscode/vsce package --allow-missing-repository --skip-license -o claude-sessions.vsix
```

## How it works

- Running chats come from `~/.claude/sessions/<pid>.json`, filtered to processes started by this window's extension host.
- × on the chat on screen first switches to the previous chat in the list that has messages, else the next one, else a new chat, because Claude shows an error on a chat whose process exits non-zero. Empty chats are skipped: Claude replaces them with a new chat when asked to show them.
- The chat on screen is always selected in the list. It is read live from Claude's own log: `engine_ui_attach` / `engine_ui_detach` name the channel on screen, and the channel's `Launching Claude on channel` time is matched to the session's `procStart`. A Claude update may break it; the list then stops highlighting and × falls back to always switching first.
