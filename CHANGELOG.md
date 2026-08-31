# Changelog

All notable changes to dsh-auto-image (the `dsh-auto-vision` plugin).

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
