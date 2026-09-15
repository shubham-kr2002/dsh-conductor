# Live dynamic-plugin demo package

`conductor-live-host.js` is the **exact function body** to hand to the
`cordis_define` tool (`code.host`) for an in-process demo of the control
plane inside a running DSH session. It is a faithful plain-JS port of
`src/dsh/conductor-bridge.ts` semantics (same policy classes, hold states,
one-time approval tokens, wrap-up grace + re-injecting step freeze), kept
in-memory because the dynamic-host vm exposes no filesystem.

What it does when mounted:

- `tools/pre-execute` — gates dangerous (`git push --force`, `rm -rf`,
  `terraform destroy`, …) and consequential (`pnpm add`, `git push origin`)
  commands: queues a decision, pauses the run, and denies with guidance.
- `agent/pre-step` — freezes held runs at step boundaries; re-injects the
  claimed inbox messages so nothing is lost; honors human override
  messages ("approve …") and grants 3 wrap-up grace steps after a pause.
- `ask_user_question` — mirrored into the decision queue (bookkeeping only;
  the human still answers through the native DSH card).
- Model tools `conductor_status` / `conductor_decisions` / `conductor_resolve`
  — the human steers via the agent, e.g. "check conductor decisions and
  resolve approve-once".
- `harness.handle('peek')` — JSON snapshot for a Client-half UI.

Define with:

```
cordis_define {
  plugin: { kind: "new", idPrefix: "cndc" },
  name:   "conductor-live-demo",
  purpose:"Live control-plane demo: gates dangerous calls, freezes for judgment.",
  code:   { host: <file contents> }
}
```

then `cordis_run(pluginId, packageId, "run")`. Note: dynamic Packages are
process-memory-only; stopping the plugin (or restarting DSH) removes them.
For permanent mounting use the static composition row documented in
ARCHITECTURE.md §8 instead.

> Session note (2025-09): the Web-GUI transport in use when this demo was
> authored passed object-typed tool arguments as strings, which the live
> `cordis_define`/`cordis_inspect_query(input)` validators reject; the demo
> was validated offline (`node --check` on the exact `(async () => { … })()`
> precheck form) and via the repo's 18 bridge/mounting unit tests.
