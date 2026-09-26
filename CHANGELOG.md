# Changelog

All notable changes to dsh-auto-image (the `dsh-auto-vision` plugin).

## 0.1.4 — 2026-09-26

Migrate to the DeepSeek Harness 0.1.7 release window and satisfy the DSH
STORE fixed-source contract.

**Manifest**

- Declare `engines.node` (`^22.19.0 || >=24.0.0`, matching the DSH host) and
  `dsh.compatibility` (`dsh`, per-release `dshReleases`, `dshOperations`,
  `profiles`).
- Ship **no runtime dependencies**: the `schemastery` dependency is replaced by
  the official `@deepseek-ai/schemastery` peer, which the DSH installation
  already provides. Every `@deepseek-ai/*` module resolves from the host, as
  before.
- Narrow every `@deepseek-ai/dsh-*` peer range to `>=0.1.7-alpha.2`, the window
  this version actually supports.

**DSH 0.1.7 API migration**

- Settings: `settings.installSection` and its `setSource` callback are gone in
  0.1.7. Configuration fields are now cordis volatile references read through
  `.get()`; form edits commit in place without remounting the plugin.
- Description row: 0.1.7 has no shared catch-all `plugin` message source. The
  plugin declares its own `auto-vision` source kind with `form: 'notice'` and a
  `summary`, so the row still renders as a folded context entry.
- Content model: tool results are first-class `tool` role messages, and the
  `tool-result` block type no longer exists. The removed recursion is dropped;
  request-side stripping still covers every message of a request, tool results
  included.
- The `settings/updated` event is gone; auto-declaration is rescheduled from the
  surviving `llm/adapters-updated` event and on plugin load.

**Verification**

- Install / start / uninstall / rollback exercised against a disposable DSH
  profile for each release declared in `dsh.compatibility.dshReleases`.

## 0.1.3 — 2026-08-31

Adapt to the DeepSeek Harness 0.1.2 settings/client API.

- Migrate settings registration to `ctx.settings.installSection` (the
  `installSettingsSection` / `settingsNamespace` exports were removed in
  DSH 0.1.2-alpha.2; the previous version fails to load there).
- Register the `auto-vision` namespace through the optional `settings`
  service (`ctx.inject(['settings'])`), so the plugin still loads in
  compositions without a settings provider.
- `declareImageInputs` now consumes the 0.1.2 `SettingsProvider` shape
  (`get` / `update`); the `llm-deepseek` (`inputModalities`) and
  `llm-pi-ai` (`input`) declaration fields are unchanged.
- Update peer/dev dependency ranges to `>= 0.1.2-alpha.2`.

## 0.1.2 — 2026-08-27

- Recognition route follows the session model's provider group by
  model-name match, surviving provider renames.
- Images stay visible in the user message; requests are stripped at
  `llm/stream` without placeholder text.

## 0.1.1 — 2026-08-26

- Put recognition instructions in the prompt text instead of the system
  slot (gateways rejecting the developer role).

## 0.1.0 — 2026-08-24

Initial public release.
