# plan-progress

Live progress bars above the Claude Code prompt. Claude splits a task into stages and steps, and the bar fills as it works. The subagents of each task are listed under its bar.

This is a clean-room version of the idea behind [zycck/claude-mods](https://github.com/zycck/claude-mods) (MIT), written from scratch without any of its code.

## What it shows

- **One row per task:** a state icon, the title, the bar, the percent done and ✕ to close.
- **The bar:** stages are capsules and steps are dots, with a pill for the current stage. Hover the pill or a marker to see its timing (desktop app).
- **Four states:**
  - running (purple)
  - needs input (orange `?`)
  - error (red `✕`)
  - done (green `✓` and the total time)
- **Subagent rows** under the task they work for: number, description, model and effort, current tool and time. Older rows fold into "N more agents · N done".
- **Approved plans:** a plan you approve in plan mode becomes the bar `plan`.
- **Sounds:** short ones for a question, an error and done.
- **Resume:** bars are saved per session and come back when you resume it.

## Where the bars show

- **Local sessions** (the terminal, or the desktop app's local Code tab): above the prompt.
- **Cloud sessions** watched from the app: the app draws nothing above the prompt there, so a side pane, **Plan progress**, opens by itself when the first bar is created. `/progress-pane` opens it anywhere.

## Security

The mod is one hooks module and three sound files. It calls only these engine features:

- **state, store and clock:** its own data and timers
- **audio:** its own sound files
- **session id:** to save bars per session
- **tool and command registration**
- **drawing** above the prompt and in its own side pane

It has no network access, no update checker, no shell commands and no file access. Run `claude plugin validate .` to see the full list of calls on `$`.

## Commands

- `/progress` shows or hides the bars.
- `/progress-clear` removes all bars.
- `/progress-agents` folds or shows the agent rows.
- `/progress-pane` shows the bars in a side pane.
- `/plan-progress-autoclose` turns on (or off again) finished bars leaving on their own after `doneBarSeconds`.

Options in `/config`:

- `doneBarSeconds` (default 30)
- `twinkle` (animated fill, on by default)
- `sounds` (on by default)

## How Claude uses it

The mod registers a `plan_progress` tool. Claude sends the plan once:

```
{id, title, stages:[{name, steps:[{title}]}]}
```

Then it sends short updates:

- `{id, next:true}`
- `{id, done:["A"], active:"B"}`
- `{id, failed:"B", note}`
- `{id, state:"needs_input", note}`
- `{id, state:"done"}`

An unknown step title is refused, and the refusal lists the bar's steps. The agent rows come from engine events and cost no tokens.

## Install

At the prompt of a terminal session:

```
/plugin install plan-progress --marketplace FatBags/plan-progress
```

From a shell:

```
claude plugin install plan-progress --marketplace FatBags/plan-progress
```

In the desktop app, click + next to the prompt box, then Plugins. Add the marketplace `FatBags/plan-progress`, then add the plugin.

If the repository is private, installing needs a git credential for GitHub on that machine (an SSH key, or `gh auth login` then `gh auth setup-git`).

## Tests

```
claude plugin test .
```
