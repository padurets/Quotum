# Third-party notices

Quotum is MIT-licensed (see `LICENSE`). It includes or relies on:

- **Rust crates** compiled into the agent and the desktop app, each under its own
  license. Their license texts are in `THIRD_PARTY_LICENSES.md`, written by
  `npm/licenses.mjs` when a program is built: the agent's is shipped with every binary
  (the npm packages and the release archives), the app's in its `licenses/` folder.
- **Node.js**, which the desktop app carries to run its hub. Its license is in the
  app's `licenses/node-LICENSE`.
- **JavaScript packages** bundled into the dashboard (React and a few more). Their
  license texts are written by the build next to it: every hub serves them at
  `/third-party-licenses.md`. The hub's server packages keep their own license files
  in the image's `node_modules`; the desktop app's hub, bundled into one file, lists
  them in `server-licenses.md` next to it.

- **Provider icons** in `hub/ui/icons/` come from [LobeHub Icons](https://github.com/lobehub/lobe-icons)
  (MIT). Claude, Codex and Antigravity names and logos are trademarks of their
  respective owners; they are used only to label the data shown for each provider.
  This project is not affiliated with or endorsed by Anthropic, OpenAI or Google.
- **Fonts**: Geist and Geist Mono (SIL Open Font License 1.1), bundled from the
  `@fontsource-variable/*` npm packages.
- **Reset announcements** are read from the public APIs of [Codex Resets](https://codex-resets.com)
  and [Claude Resets](https://claude-resets.com) and credited with a link wherever
  they are shown, as their terms ask.
- **CodexBar** ([steipete/CodexBar](https://github.com/steipete/CodexBar)) was the data
  source of the first versions of the dashboard. Nothing of it is bundled or used now.
