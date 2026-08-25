# dsh-auto-vision

**Lets models without image input (e.g. `deepseek-v4-pro`, `deepseek-v4-flash`) receive screenshots.** A configured vision model describes pasted images, and the descriptions enter the durable session history as **folded context rows** — your original message stays untouched. No DSH source changes.

[中文说明](./README.md)

## Features

- **Your message stays untouched.** Pasting an image into a non-vision model (e.g. `deepseek-v4-pro`, `deepseek-v4-flash`) keeps your text exactly as sent; the vision description becomes a separate, collapsed context entry (`auto-vision · recognized N image(s)`), expandable like a thinking row.
- **Durable memory.** Descriptions are appended to the session log, so later turns can reference the same image memory. Every new screenshot adds a fresh timestamped description; the model naturally favors the latest one.
- **Per-model, not per-session.** Models on the `nativeVision` allowlist (e.g. vision models) are never touched — they see the images themselves.
- **Recursive coverage.** Images nested inside tool results (e.g. `read_image`) are bridged too, so a model that "successfully" reads an image never sends raw bytes to a gateway that would reject them.
- **Failure-safe.** Recognition failures degrade to a `[recognition failed: …]` note in the context row; your text still reaches the model. Cancellation aborts cleanly.

## How it works

1. **Admission (settings)**: the GUI rejects images for models that do not declare `image` input. Declare `input: [text, image]` on the bridged models in `settings.yaml` — the admission check trusts the model declaration and lets the message in.
2. **Accurate model snapshot (plugin)**: the plugin listens to `system-prompt/assemble` (fires right before `agent/pre-step`, same step) and reads the provider/model the GUI just selected from `assembly.variables`.
3. **Rewrite (plugin)**: at `agent/pre-step`, images in messages whose model is not on the `nativeVision` allowlist are removed and replaced by a separate notice-form context message carrying the vision description. The agent loop appends both messages to the session log.
4. **Group-following recognition route**: the recognition route follows the session model's provider group — images sent in one provider group are described by that group's own vision model (same credentials); groups without a native vision entry fall back to `visionProvider`/`visionModel`.

No DSH source changes required.

## Requirements

- DeepSeek Harness with the plugin bundle system (`dsh plugin add`, profiles).
- A registered vision model route (any provider; `deepseek-official/deepseek-v4-flash-vision-exp` by default).
- DSH host packages `>= 0.1.0-rc.7` (uses `system-prompt/assemble` variables and the notice context form).

## Install

Prebuilt `lib/` is committed to the repository, so installs need **no build step**.

From GitHub:

```sh
dsh plugin --profile web add github:soarGuo/dsh-auto-vision
```

From npm (once published):

```sh
dsh plugin --profile web add dsh-auto-image
```

From a tarball:

```sh
pnpm pack          # produces dsh-auto-image-0.1.0.tgz (inside the repo)
dsh plugin --profile web add ./dsh-auto-image-0.1.0.tgz
```

Then restart DSH.

## Configuration

**Zero manual setup for model declarations.** By default (`autoDeclareInput: true`) the plugin scans the `llm-pi-ai` and `llm-deepseek` settings sections on startup (and whenever settings/adapters change) and automatically adds `image` input declarations to every configured model — the step the GUI admission check needs to let images through. Native vision models get the declaration too (they need it to receive images at all). Idempotent; already-declared models are untouched.

The plugin's own section (all fields optional; these are the defaults):

```yaml
auto-vision:
  visionProvider: deepseek-official              # recognition route
  visionModel: deepseek-v4-flash-vision-exp      # recognition model
  nativeVision:                                  # models that see images natively (untouched)
    [
      { provider: deepseek-official, model: deepseek-v4-flash-vision-exp },
      { provider: deepseek, model: deepseek-v4-flash-vision-exp }
    ]
  autoDeclareInput: true                         # auto-add image declarations (set false to manage manually)
```

Set `autoDeclareInput: false` if you prefer to declare `input: [text, image]` yourself (then follow the manual steps below). Settings hot-reload — no restart needed for config changes.

### Manual declaration (only when autoDeclareInput is false)

```yaml
llm-pi-ai:
  providers:
    {
      my-gateway:
        {
          displayName: My Gateway,
          models:
            [
              { id: my-pro, name: My-Pro, input: [ text, image ] },
              { id: my-vision, name: My-Vision, input: [ text, image ] }
            ],
          baseURL: https://example.com/v1,
          apiKeyEnv: MY_API_KEY
        }
    }
```

Remember to add the bridged models to `nativeVision` **only if** they really see images; otherwise the plugin bridges them (which is the point).

## Caveats

- Declaring `input: [text, image]` makes the GUI show bridged models as image-capable; the plugin actually bridges the images.
- With the plugin disabled, do not send images to bridged models — raw bytes would reach the gateway and be rejected.
- Recognition runs on the configured vision model and costs its tokens.

## Development

```sh
pnpm install
pnpm test        # vitest
pnpm typecheck
pnpm build       # rebuild lib/ (commit it before releasing)
```

## License

MIT
