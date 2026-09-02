# CC Diff Review

**Review your AI agent's edits — accept or reject each change — on stock VS Code.
No AI inside it, no provider, no account, no editor fork.**

Run Claude Code (or any tool that can run a command hook) in auto / accept-edits
mode, then browse exactly what changed and **accept or reject each hunk**. The
removed lines stack in red directly above the added lines in green, just like a
review should read.

> **What it is not:** this extension contains **zero AI**. It never calls a model,
> needs no API key, and talks to no provider. Your agent does the editing — this
> just reviews what already happened. That's the whole point: keep the setup you
> already have, add a clean review layer on top.

## Why

- **Cursor / Windsurf** give you review UX — but they're whole **editor forks** you
  have to move into.
- **Cline / Roo** give you review UX — but they **are** the agent; you plug a
  provider into them.
- **CC Diff Review** rides alongside the agent you already run, on **standard VS
  Code**, and is provider-agnostic because it never speaks to a provider at all.

## How it works

1. A **`PreToolUse` hook** saves each file's *pre-edit* content to
   `.ccdiffs/snapshots/` the instant before your agent first edits it. First
   touch wins, so the baseline survives a whole batch of edits.
2. Your agent edits freely.
3. The extension diffs **baseline → current** and shows, per file:
   - green lines for additions/changes, a red marker where lines were removed
     (hover to see the removed text),
   - a **status-bar counter** of pending changes, and overview-ruler ticks so
     you can find changes in large files,
   - **Accept / Reject** per hunk (CodeLens) and **Accept all / Reject all** plus
     **Open diff** in the editor title bar.
4. **Open diff** opens VS Code's native diff editor in **stacked (unified)** mode:
   deleted lines in red directly above inserted lines in green.
5. **Accept** folds the change into the baseline; **Reject** restores the
   original lines. When every hunk is resolved the file goes quiet, and any open
   diff for it closes automatically.

## Install & wire it to your agent

Install the extension, then add the hook to your agent's config. For **Claude
Code**, add this to `settings.json` (user or project scope), using the
**absolute** path to the bundled `hook/snapshot.js` (shown on the extension's
files, or copy it anywhere stable):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          { "type": "command", "command": "node /ABS/PATH/hook/snapshot.js" }
        ]
      }
    ]
  }
}
```

Run your agent in accept-edits / auto mode as usual. As it edits, snapshots land
in `.ccdiffs/snapshots/`; open a changed file and review. Add `.ccdiffs/` to your
project's `.gitignore`.

### Try it without an agent

1. Open any file and run **CC Diffs: Snapshot current file (baseline)**.
2. Hand-edit the file — decorations and Accept/Reject appear.
3. Click Accept / Reject, or open the stacked diff.

## Commands & shortcuts

- **Open diff (deleted ↔ inserted)** — `Cmd/Ctrl+K Cmd/Ctrl+D`
- **Accept hunk at cursor** — `Cmd/Ctrl+Enter`
- **Reject hunk at cursor** — `Cmd/Ctrl+Backspace`
- **Accept all / Reject all in file** — title-bar buttons
- **Snapshot current file (baseline)** / **Refresh review** — Command Palette

## The honest limitation

VS Code's public extension API can't draw removed lines as their own rows *inside*
a normal editor — that needs core-only "view zones", which is exactly why Cursor
and Void are forks. So in-file you see green + a red marker, and the full
red-above-green view is one click away in the diff editor. Functionally complete
review; not an editor fork.

## Support

If this saves you time, you can support it here: **https://ko-fi.com/lucipanuci** 💚

## License

[MIT](LICENSE) © 2026 Lucian Stoian
