# AI Studio

**Mode**: 🔐 Browser · **Domain**: `aistudio.google.com`

The adapter drives Google AI Studio through the OpenCLI Browser Bridge and the
current Chrome login. It supports text and visual prompts, image generation,
speech (TTS) generation, video (Veo) generation, live model discovery, Run
settings, and Google account checks.

## Commands

| Command | Description |
|---|---|
| `opencli aistudio ask <prompt> [options]` | Send a prompt and return only the completed model response |
| `opencli aistudio image <prompt> [options]` | Generate images and optionally save every result locally |
| `opencli aistudio audio <script> [options]` | Generate speech audio (TTS) and save the take locally |
| `opencli aistudio video <prompt> [options]` | Generate videos (Veo) and save every take locally |
| `opencli aistudio models [options]` | List models currently visible in the AI Studio model picker |
| `opencli aistudio status` | Check page readiness, authentication, and the selected model |
| `opencli aistudio login [--timeout N]` | Open Google login and wait for a verified AI Studio session |
| `opencli aistudio whoami` | Show the Google account used by AI Studio |

`--profile` is a global OpenCLI option and must appear before the site name.
Browser options such as `--window` belong after the command:

```powershell
opencli --profile camelia aistudio status --window background -f json
```

## Examples

```powershell
# Ask with the default text model; every ask starts a clean chat.
opencli aistudio ask "Reply with exactly: READY"

# Select an exact model and a Thinking value exposed by that model.
opencli aistudio ask "Summarize this in three bullets" `
  --model gemini-3.7-flash --thinking Low --max-output-tokens 300

# Configure tools and advanced settings. Omitted switches remain unchanged.
opencli aistudio ask "Use current sources and return JSON" `
  --google-search true --structured-output true --media-resolution High

# Preserve the response's original Markdown source when the UI action is available.
opencli aistudio ask "Write a Markdown table" --copy-as-markdown true

# Set exact safety categories and add stop-sequence chips.
opencli aistudio ask "Classify this text" `
  --safety-settings '{"Harassment":"Block some","Hate":"Block most"}' `
  --stop-sequences '["DONE","STOP"]'

# Attach a local image to a text prompt.
opencli aistudio ask "What is in this image?" --image C:\images\photo.png

# Generate and save every returned image.
opencli aistudio image "A red apple on a white table" `
  --model gemini-3.1-flash-lite-image --aspect-ratio 16:9 --resolution 1K

# Generate without exporting pixels; return the AI Studio prompt link.
opencli aistudio image "A red apple" --skip-download true

# Speak a script (supports [pause]-style speech tags) and save the WAV take.
opencli aistudio audio "[cheerful] Welcome to OpenCLI!" --model gemini-2.5-flash-preview-tts

# Generate a Veo video; renders take minutes, so the default timeout is 600s.
opencli aistudio video "A drone shot over a coastline at sunrise" `
  --model veo-3.1-lite-generate-preview --aspect-ratio 16:9

# Discover current model ids and supported categories.
opencli aistudio models --category text --query flash -f json

# Check the current Google identity.
opencli aistudio whoami -f json
```

On shells other than PowerShell, replace the backtick line continuations with
the shell's native syntax.

## `ask` options

| Option | Description |
|---|---|
| `prompt` | Required positional prompt |
| `--image` | Local image path for a visual prompt |
| `--model` | Canonical id or unique name from `aistudio models`; defaults to `gemini-3.7-flash` and can be overridden with `OPENCLI_AISTUDIO_MODEL` |
| `--thinking` | Exact Thinking Level currently exposed by the selected model; values are model-specific (for example `Low`, `Medium`, `High`, or `Minimal`) |
| `--temperature` | Sampling temperature within the live DOM range; fails if the model does not expose the control |
| `--top-p` | Top P within the live DOM range; it is never treated as Top K |
| `--max-output-tokens` | Positive integer within the selected model's live range |
| `--system-instruction` | System instruction; an empty string clears it |
| `--structured-output` | Enable or disable Structured outputs; omit to preserve the current value |
| `--code-execution` | Enable or disable Code execution; omit to preserve the current value |
| `--function-calling` | Enable or disable Function calling; omit to preserve the current value |
| `--google-search` | Enable or disable Grounding with Google Search; omit to preserve the current value |
| `--google-maps` | Enable or disable Grounding with Google Maps; omit to preserve the current value |
| `--url-context` | Enable or disable URL context; omit to preserve the current value |
| `--media-resolution` | Exact media resolution exposed by the model, such as `Default` or `High` |
| `--stop-sequences` | Comma-separated values or a JSON string array; complete chip values are matched exactly and added to the current settings |
| `--safety-settings` | JSON object using the exact categories `Harassment`, `Hate`, `Sexually Explicit`, and `Dangerous Content` |
| `--copy-as-markdown` | Use AI Studio's Copy as Markdown action after completion; default `false` |
| `--timeout` | Shared command deadline in seconds; default `120` |

`--copy-as-markdown` writes the response to the system clipboard because that
is how AI Studio exposes the original source. The adapter accepts the clipboard
only when it closely matches the rendered answer; otherwise it falls back to
the DOM response so stale clipboard contents cannot replace the result.

## `image` options

| Option | Description |
|---|---|
| `prompt` | Required positional image prompt |
| `--image` | Local reference image for editing or image-to-image generation |
| `--model` | Image model id or unique name; defaults to the first currently available image model |
| `--aspect-ratio` | Exact ratio exposed by the model, for example `1:1`, `16:9`, or `9:16`; default `1:1` |
| `--resolution` | Exact exposed resolution; the implicit `1K` default is skipped when the model has no resolution control |
| `--output` | `images` or `images-text`; default `images` |
| `--thinking`, `--temperature`, `--top-p`, `--max-output-tokens` | Same live-control behavior as `ask` |
| `--system-instruction`, tool switches, `--media-resolution` | Same behavior as `ask` |
| `--stop-sequences`, `--safety-settings` | Same behavior as `ask` |
| `--output-dir` | Save directory; default `~/Pictures/aistudio` |
| `--skip-download` | Return generated metadata and the prompt link without exporting pixels; default `false` |
| `--timeout` | Shared command deadline in seconds; default `240` |

Before writing files, the adapter verifies that every distinct generated image
was exported and that each asset has valid image data and dimensions of at least
512×512. If only part of a multi-image response can be exported, the command
fails with the AI Studio link instead of reporting partial success.

## `audio` options

TTS runs on the dedicated speech studio (`/generate-speech`), not the chat
surface. The script goes into the "Speech block text" editor and each take is
saved as a WAV/MP3 file.

| Option | Meaning |
|---|---|
| `--model` | TTS model id (default: first available audio model) |
| `--output-dir` | Output directory (default: `~/Music/aistudio`) |
| `--skip-download` | Return the AI Studio link without downloading |
| `--timeout` | Maximum generation time in seconds (default: 240) |

## `video` options

Veo reuses the chat surface under `/prompts/new_video`; renders take minutes,
so both the stall and empty-shell windows are widened for this command.

| Option | Meaning |
|---|---|
| `--model` | Video model id (default: first available video model; Veo tiers are paid) |
| `--aspect-ratio` | `16:9` (default) or `9:16` |
| `--duration` | Video duration shown by the model, e.g. `8s` (omitted = leave unchanged) |
| `--output-dir` | Output directory (default: `~/Videos/aistudio`) |
| `--skip-download` | Return the AI Studio link without downloading |
| `--timeout` | Maximum generation time in seconds (default: 600) |

## `models` options

| Option | Description |
|---|---|
| `--category` | `all`, `text`, `image`, `video`, `audio`, `live`, or `gemma`; default `all` |
| `--query` | Case-insensitive filter over id, name, and description |

The command walks the virtualized picker, deduplicates canonical model ids, and
requires the picker dialog to close before returning data.

## Strategy note

```md
Strategy: UI_SELECTOR + DOM_STATE (registry session: COOKIE via the browser bridge)
Contract: visible-ui
Evidence:
- observed request/state: prompt composer textarea, Run button with its shortcut chip,
  virtualized model-picker dialog, completed-turn DOM; AI Studio exposes no public API
  and its internal XHR endpoints are undocumented and token-gated
- auth source: real Chrome login state held by the browser bridge persistent session
- replay result: HTTP replay not applicable; correctness is pinned by `opencli browser verify`
  plus JSDOM unit tests against frozen zh-CN DOM fixtures in `clis/aistudio/__fixtures__/`
```

Semantic anchors are user-visible UI elements (composer, Run button, picker rows), so
failures surface as typed errors (`ArgumentError`, `AuthRequiredError`, `EmptyResultError`,
`TimeoutError`, `CommandExecutionError`) instead of silent empty results.

## Execution contract

- `ask` uses an ephemeral site session and starts a fresh AI Studio chat for
  every call. `image`, `models`, `status`, `login`, and `whoami` use the
  persistent site session.
- A visible foreground tab submits exactly once with a trusted native `Enter`
  or `Ctrl+Enter`/`Command+Enter`, chosen from the Run button shortcut. A
  background or still-hidden tab submits exactly once by clicking Run.
- Submission polling never sends a second key or click. Multiple new user turns
  are treated as an error.
- `--timeout` is one shared budget for navigation, model/settings work, upload,
  submission confirmation, response waiting, and browser-side image export.
- Text is accepted only after the completed response remains stable for 1.5
  seconds. The DOM extractor preserves headings, lists, tables, fenced code,
  syntax-highlighted tokens, and KaTeX source where AI Studio exposes it.
- Generic `role=alert` live regions are not errors by themselves. Explicit
  error elements and narrow quota, auth, safety, timeout, or refusal phrases are
  surfaced as typed command failures.

## Troubleshooting

| Symptom | Action |
|---|---|
| Thinking value rejected | Run `aistudio models`, then inspect the selected model's live Run settings; values differ by model and can change |
| Temperature or Top P unavailable | Omit the option or choose a model that exposes the corresponding control |
| Trusted submit key unavailable | Update/enable the Browser Bridge, or use `--window background` for the single Run-click path |
| Login, consent, region, or upgrade dialog reported | Complete the flow in the retained AI Studio tab, then retry |
| Image export reports missing assets | Open the returned AI Studio link and download the missing image manually |
| Stop sequence already present | Matching is by complete chip value; remove unwanted chips in the UI when exact replacement is required |

Run `opencli aistudio --help -f yaml` for the command surface installed on the
current machine.
