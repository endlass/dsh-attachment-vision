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

# register in your home patch (~/.dsh/cordis.patch.yml or profile patch):
#   - insert:
#       - id: dsh-attachment-vision
#         name: dsh-attachment-vision
```

Or via npm (once published):

```sh
dsh plugin --profile demo add dsh-attachment-vision
```

Then restart dsh.

## Configuration

Credentials are resolved from `~/.dsh/.env` / `.credentials.yaml` via the dsh credentials service:

| Variable | Required | Default |
|---|---|---|
| `QWEN_VL_API_KEY` (or `VISION_API_KEY` / `DASHSCOPE_API_KEY`) | **yes** | — |
| `QWEN_VL_BASE_URL` | no | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `QWEN_VL_MODEL` | no | `qwen3-vl-flash` |

Any OpenAI-compatible endpoint works (DashScope, Zhipu, Volcano Ark, Ollama at `http://localhost:11434/v1`, ...).

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

## Caveats (architectural dependencies)

- **dsh-attachment-local storage layout** — if the official storage rule changes, auto-transcription breaks. Kept intentionally tight; the tool's `view_image` still works for arbitrary paths/URLs.
- **dsh-llm deep-freeze invariant + waterfall veto semantics (rc.6)** — the hook relies on listeners being able to veto by not calling `next()` and re-entering `ctx.llm.stream()`. dsh upgrades need regression testing.
- Single image max 10MB (base64-inlined), 180s timeout, `stripThink` applied to reasoning-model outputs.

## Development

```sh
npm run check      # node --check lib/index.js
bash scripts/verify.sh   # headless smoke: mount plugin in a temp DSH_HOME and ask dsh one question
```

## License

MIT
