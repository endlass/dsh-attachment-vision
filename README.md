# dsh-attachment-vision

Give text-only DeepSeek models eyes. **Zero-dependency, single-file CommonJS plugin** for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/dsh).

Unlike plain `view_image`-only plugins, this one also handles **GUI image attachments**: when you attach an image in the dsh web UI, the plugin patches the DeepSeek adapter's modality declaration (so the upload check passes) and auto-transcribes the image block into a local attachment path text, then the model calls `view_image` to actually read it. End-to-end image understanding on a text-only model.

## Features

1. **Modality gate bypass (reversible)** — patches `deepseek-official` adapter's `resolveModel` to declare `image` input, so attaching images in the web UI is accepted.
2. **Image-block auto-transcription** — in the `llm/stream` waterfall, image blocks are rewritten to a text note containing the attachment's real local path (see *Attachment storage rule* below). Uses the waterfall **veto** pattern: the original deep-frozen messages are never mutated; a shallow-copied request with a re-entry marker is re-fed into `ctx.llm.stream()`.
3. **`view_image` tool** — local path / `file://` / public `http(s)` URL → any OpenAI-compatible VLM (default: DashScope `qwen3-vl-flash`) → text description returned to the model.

## Install

Requires dsh **>= 0.1.0-rc.6** and Node **>= 20.11**.

```sh
# git install (any location, e.g. ~/dsh-plugins)
git clone https://github.com/TO-BE-PUBLISHED/dsh-attachment-vision ~/dsh-plugins/dsh-attachment-vision

# one-command install (idempotent: copies plugin, registers in cordis.patch.yml, checks API key)
bash ~/dsh-plugins/dsh-attachment-vision/scripts/install.sh
```

Or register manually in your home patch (`~/.dsh/cordis.patch.yml` or profile patch):

```yaml
- insert:
    - id: dsh-attachment-vision
      name: dsh-attachment-vision
```

Or via npm (once published):

```sh
dsh plugin --profile demo add dsh-attachment-vision
```

Then restart dsh.

## Configuration

Credentials are resolved from `~/.dsh/.env` / `.credentials.yaml` via the dsh credentials service, in this order: `QWEN_VL_API_KEY` → `VISION_API_KEY` → `DSH_VISION_API_KEY` (export only; dsh 0812+ forbids `DSH_`-prefixed vars inside `.env`) → `ZHIPUAI_API_KEY` → `DASHSCOPE_API_KEY`.

| Variable | Required | Default |
|---|---|---|
| any of the keys above | **yes** | — |
| `QWEN_VL_BASE_URL` | no | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `QWEN_VL_MODEL` | no | `qwen3-vl-flash` |
| `QWEN_VL_FALLBACK_MODELS` | no | *(empty)* |

**Fallback chain**: `QWEN_VL_FALLBACK_MODELS="glm-4.6v-flash,glm-4v-flash"` (comma-separated). When the primary model hits a retryable failure (HTTP 429 / 5xx / timeout / network error), the plugin automatically tries the next model in order; the reply notes which fallback model served the request. Config-class errors (401 / 404) fail immediately without falling back. Works with any model names on the same `QWEN_VL_BASE_URL` endpoint.

Debug logs (to `/tmp/dsh-attachment-vision.log`): `DSH_ATTACHMENT_VISION_DEBUG=1`.

## How it works

```
user attaches image in web UI
  → modality gate patched (image accepted)
  → llm/stream hook rewrites image block → text note with real attachment path
  → model decides to call view_image(path, question)
  → plugin reads the file (or URL), base64-inlines it, calls the VLM
  → VLM description returned as tool result → model answers
```

**Attachment storage rule** (depends on `dsh-attachment-local`, see *Caveats*):
`attachmentId = "sha256:<64hex>"` → file at `~/.dsh/attachments/v1/objects/<first-2-hex>/<64hex>` (raw bytes, **no extension**).

## Security & robustness

- **API key redaction**: error messages are scrubbed (`key → ***`) before being shown to the model — no credentials leak through VLM endpoints, 4xx bodies, or unexpected exceptions.
- **Multi-backend tolerant response parsing**: VLM `content` may be a string or a parts array; both are handled.
- Supported local formats: png / jpg / jpeg / webp / gif / bmp / tif / tiff / heic (magic-byte sniffing preferred, extension as fallback).

## Caveats (architectural dependencies)

- **dsh-attachment-local storage layout** — if the official storage rule changes, auto-transcription breaks. Kept intentionally tight; the tool's `view_image` still works for arbitrary paths/URLs.
- **dsh-llm deep-freeze invariant + waterfall veto semantics (rc.6)** — the hook relies on listeners being able to veto by not calling `next()` and re-entering `ctx.llm.stream()`. dsh upgrades need regression testing.
- Single image max 10MB (base64-inlined), 180s timeout, `stripThink` applied to reasoning-model outputs.

## Development

```sh
npm run check         # node --check lib/*
npm test              # node:test unit tests (zero-dep, 26 cases: rewrite/path/mime/redact/vlm/fallback)
bash scripts/verify.sh  # headless smoke: mount plugin in a temp DSH_HOME and ask dsh one question
```

Code layout: `lib/index.js` is the Cordis wiring layer; all pure logic lives in `lib/core.js` (unit-testable, no dsh API coupling).

## License

MIT
