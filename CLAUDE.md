# plan-progress

A Claude Code mod (hooks module plugin): live plan progress bars above the prompt, with subagent rows under each bar. This repository is both the plugin and its marketplace (`.claude-plugin/marketplace.json`, source `./`).

It is a clean-room rewrite of the idea in https://github.com/zycck/claude-mods (`plugins/plan-progress`, MIT). The owner wants the same behaviour and look, with no security risk.

## Security rules (hard requirements)

- Only these engine calls: `$.state`, `$.store`, `$.clock`, `$.audio.play` (its own `sounds/`), `$.session.id`, `$.tool.register`, `$.command.register`, `$.ui.*`.
- Never `$.http`, `$.process`, `$.fs`, `$.env`, `$.mcp`, `$.model`, or anything that reaches the network, runs commands or touches files. No self-update, no update check.
- No dependencies. `claude plugin validate .` lists every call on `$`; check its `calls:` line after each change.
- The original repo is **reference only**. Read it (clone it outside this repo, e.g. into `/tmp`) for behaviour and UI ideas, but never run its code, scripts or tests, and never copy its code verbatim. It uses `$.process.run`, `$.http.fetch` and `$.fs.read`, which this mod must not.

## Layout

- `hooks/register.tsx`: the whole module. It holds the plan model (pure `apply`), drawing (`barSvg` for desktop, `barCells` for the terminal, `drawBars` shared by the band and the pane) and the hooks.
- `types/index.d.ts`: the `$.state` contract (`plan-progress.list`, `isHidden`, `isAgentsFolded`, `tick`).
- `tests/plan.test.tsx`: tests on the engine's test kit.
- `.claude-plugin/plugin.json`: bump `version` on every change that should reach installed copies.

## Dev loop

- Type-check: `tsc -p .`. The engine lays `.claude-plugin/types/` when it loads the mod from a dev folder; that folder is gitignored.
- Tests: `claude plugin test .`
- Validate: `claude plugin validate .`

## Lessons learned

- Desktop: draw the bar as a plain `Svg` image, never `isInteractive`. Interactive SVGs sit in a frame the app rebuilds on every redraw, so the bar flashes blank. Keep the SVG source free of clock-dependent text, so it only changes when the bar does. SMIL animation in the plain image does the twinkle. Hover info comes from keyed `Box`es with `hover` on top.
- A `ui.render` hook must not write state. Use module variables (e.g. `live.bandSeen`).
- Changing a `$.state` atom's shape breaks values an earlier version saved. Use a new key and validate what is read (`asBars`). `session.start` registers the tool and commands before restoring anything.
- Avoid APIs the original never uses (e.g. `tool.check`, regex tool matchers). They may not load on every Claude Code version.
- The usage rules go in the system prompt (`prompt.compose`, always added), so Claude uses the bars in every mode.
- Cloud sessions watched from the app attach no surface (`$.session.surfaces()` is empty), so nothing a mod draws shows there. Work in a local session.
