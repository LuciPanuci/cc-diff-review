# Changelog

## 0.1.0 — first public release

- Post-edit **diff review** for local agent edits (Claude Code and any tool that
  can run a `PreToolUse` command hook).
- **Per-hunk Accept / Reject**, plus **Accept all / Reject all**, from CodeLens
  and the editor title bar.
- **In-file markers**: green for added/changed lines, red seam + gutter marker
  where lines were removed, with the removed text on hover.
- **Stacked diff review**: “Open diff” shows VS Code’s native diff editor in
  unified mode — deleted (red) directly above inserted (green).
- **Auto-reconcile**: accepting folds changes into the baseline; rejecting
  restores the original lines; the file goes quiet when clean, and any open diff
  for it closes automatically.
- **Live updates** as files change, a **status-bar** pending-change counter, and
  keyboard shortcuts (accept/reject hunk at cursor, open diff).
- No AI, no provider, no account — works on stock VS Code.
