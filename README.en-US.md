<div align="center">

# 🚀 qiniu-coding-helper

[![npm version](https://badge.fury.io/js/qiniu-coding-helper.svg)](https://www.npmjs.com/package/qiniu-coding-helper)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Node.js Version](https://img.shields.io/node/v/qiniu-coding-helper.svg)](https://nodejs.org)

**One command to connect every AI coding assistant on your machine to Qiniu AI inference**

13 coding assistants · only touches Qiniu's own settings · undo anytime

[中文](README.md) · [What it does](#-what-it-does) · [Quick start](#-quick-start) · [Supported tools](#-supported-coding-assistants) · [Commands](#-commands) · [Safety](#-safety) · [FAQ](#-faq)

</div>

---

## 💡 What it does

Running Claude Code, Codex and friends on the Qiniu API normally means opening each tool's config file, looking up its format and filling in the endpoint and key by hand. Coding Helper turns that into one command:

| You want to | Run |
|---|---|
| Configure one coding assistant in one command | `npx qiniu-coding-helper codex sk-xxx`, optional model as the third argument |
| Connect every installed coding assistant to Qiniu | `npx qiniu-coding-helper setup` — pick the tools, everything is written in one go, then a summary table |
| Use Qiniu for one session without touching config files | `npx qiniu-coding-helper run claude` |
| See what would change first | `npx qiniu-coding-helper setup --dry-run` — a per-file diff with the key masked, nothing written |
| Change your key or endpoint | Change it once in the menu and pick which tools to update; on the CLI use `auth sk-xxx --sync` |
| See which tools are connected | `npx qiniu-coding-helper status` |
| Go back to how things were | `npx qiniu-coding-helper restore` — removes Qiniu entries and writes back the old values |
| Find out why it isn't working | `npx qiniu-coding-helper doctor` — key, account billing status, network, env-var overrides |
| Configure from a script or CI | `setup --yes --json`, key via `--key-stdin`, exit code tells success from failure |
| Several accounts, or switching between China and international | Profiles: `profile add work sk-xxx`, `profile use work`; Codex can even switch with `codex -p qn-work` |
| Control cost and speed | Context size: `--context 64k` or the main menu, capped at each model's maximum |

## 🚀 Quick start

No install needed, Node.js 18+. **One command**: tool name + API key ([get one](https://portal.qiniu.com/ai-inference/api-key)) + optional model ID:

```bash
npx qiniu-coding-helper codex sk-xxx                              # model chosen automatically
npx qiniu-coding-helper claude sk-xxx deepseek/deepseek-v4-pro    # pick a model
npx qiniu-coding-helper claude,codex,opencode sk-xxx              # several tools
npx qiniu-coding-helper all sk-xxx                                # every installed tool
```

The key, account and model are checked before anything is written; the output ends with how to start and how to undo:

```text
✔ API key is valid (China (api.qnaigc.com))
✔ Model deepseek/deepseek-v4-flash (chosen automatically, pass a third argument to pick one)
✔ Configured OpenCode

Run opencode to start
Undo: npx qiniu-coding-helper restore opencode
```

Prefer to choose step by step? Run `npx qiniu-coding-helper` for the 5-step wizard: language → endpoint → API key → tick coding assistants → choose a model. Later runs open the main menu.

<p align="center"><img src="docs/images/main.png" width="720" alt="Main menu: pixel logo, connected tools as pixel characters, one-line status bar, current values on the right"></p>

| Wizard · tools | Wizard · model | Result |
|---|---|---|
| <img src="docs/images/wtools.png" alt="Two-column multi-select"> | <img src="docs/images/wmodel.png" alt="Recommended first, / to search"> | <img src="docs/images/wdone.png" alt="Connected tools light up"> |

**Only the tools you choose change.** Switching models, context size and restore all start by selecting tools (none pre-selected, `a` selects all). Before anything is written a confirmation page lists each tool's old → new values, the files that will change and the tools left untouched; `d` previews the per-file diff. After changing the key, endpoint or profile you choose which tools to update.

<p align="center"><img src="docs/images/confirm.png" width="640" alt="Confirmation page before writing"></p>

Interface highlights:
- **Restrained pixel art:** the pixel QINIU logo and calf appear only on the main menu; other pages use a one-line header and status line, with tools marked by a brand-colored dot. `CODING_HELPER_ART=0` turns the art off; below 256 colors, in narrow terminals or with `NO_COLOR` it falls back to plain text.
- **Shortcuts:** the number or letter in front of a menu item jumps straight to it; `/` searches lists; the bottom bar always shows the available keys.
- **Tools page:** grouped into installed / not installed; the selected tool shows its model, connection and config path; `m` model, `s` launch, `r` restore, `a` connect all.
- **API key:** only the first and last 4 characters are shown; on Enter it checks format, key, account and models, and switches region if the key belongs to the other one.
- **Model:** one model for the selected tools; Claude Code's main and fallback models switch together, and Codex and other incompatible tools fall back to their own default. Press `p` to pick per tool.

**Restart any coding assistant that is already running** and you're done.

## 🧰 Supported coding assistants

"Tested" means: the real client at that version was installed on Linux, `setup` was run, a real prompt was answered through the Qiniu endpoint, and `restore` was run to confirm the config came back. Tested on 2026-10-20.

| Coding assistant | Written to | Tested | Use it with |
|---|---|---|---|
| Claude Code | `env` in `~/.claude/settings.json` | ✅ 2.x | `claude` |
| Codex | `~/.codex/config.toml`, `~/.codex/auth.json` | ✅ 0.163.0 | `codex` |
| OpenCode | `~/.config/opencode/opencode.json` | ✅ 1.19.3 | `opencode` (default model `qiniu/<model>`) |
| Qwen Code | `~/.qwen/settings.json`, key in `~/.qwen/.env` | ✅ 0.25.3 | `qwen` |
| Kimi Code CLI | `~/.kimi-code/config.toml` | ✅ 2.2.0 | `kimi` |
| Factory Droid | `customModels` in `~/.factory/settings.json` | ✅ 0.245.0 | `droid`, pick `Qiniu: <model>` in `/model` |
| Grok CLI | `~/.grok/config.toml` | ✅ 1.0.62 | `grok` (default model points to Qiniu) |
| OpenClaw | `~/.openclaw/openclaw.json` | ✅ 2026.6.35 | `openclaw` (primary model `qiniu/<model>`) |
| MiniMax Code | Official `mcode provider add`, writes `~/.minimax/config.yaml` | ✅ 0.6.12 | `mcode` |
| GitHub Copilot CLI | No config file, env vars only | ✅ 1.0.100 | `npx qiniu-coding-helper run copilot` |
| CodeBuddy | `~/.codebuddy/models.json` | ✅ 2.170.0 | `codebuddy`, pick the Qiniu model with `--model` |
| Hermes Agent | `model` in `~/.hermes/config.yaml` | ✅ official installer | `hermes` |
| WorkBuddy | `~/.workbuddy/models.json` | ⚠️ not tested | Desktop app, start it yourself |

WorkBuddy only ships Windows / macOS desktop builds, so it can't be tested on Linux. It uses the same format as CodeBuddy (tested), and its docs say it also reads `~/.codebuddy/models.json`.

**Choosing models:**

- **Claude Code:** Haiku / Sonnet / Opus / subagent models, each optional (Claude Code defaults otherwise).
- **Codex:** fixed to Qiniu's `openai/gpt-6-astra`, plus a Qiniu GPT model catalog.
- **CodeBuddy / WorkBuddy:** pick several models from the Qiniu marketplace; capability tags and token limits are filled in automatically.
- **Hermes Agent:** pick one default model from the marketplace.
- **The other 8** (OpenCode, Qwen Code, Kimi, Droid, Grok, OpenClaw, MiniMax Code, Copilot CLI): share one model. Choose it once and `setup --yes` reuses it; each tool's own menu can override it.

**Gemini CLI is not supported yet:** it only speaks the native Gemini protocol (`/v1beta`), which Qiniu endpoints don't serve yet.

## 📚 Commands

| Command | What it does |
|---|---|
| `coding-helper <tool\|all> [key] [model]` | Configure the given coding assistants in one command |
| `coding-helper` | Wizard on first run, main menu afterwards |
| `coding-helper setup` | Configure the coding assistants on this machine |
| `coding-helper status` | Read each tool's actual config and show whether it points to Qiniu |
| `coding-helper restore [tools]` | Remove Qiniu config and restore previous values |
| `coding-helper run <tool> [args...]` | Launcher: inject Qiniu settings into one launch only |
| `coding-helper doctor` | Health check |
| `coding-helper profile [list\|add\|use\|remove]` | Profiles: switch between keys / endpoints |
| `coding-helper auth [token]` | Set the API key; `auth revoke` removes it, `auth reload <tool>` rewrites one tool |
| `coding-helper enter [tool]` | Open the main menu or one tool's menu |
| `coding-helper init` | Run the first-run wizard again |
| `coding-helper lang show` / `lang set zh_CN\|en_US` | Show or change the UI language |

`coding-helper` in the examples below can be written as `npx qiniu-coding-helper`. Tool names accept aliases such as `claude`, `qwen`, `kimi`, `mcode`, `factory`.

### 🎯 One command: tool + key + model

```bash
coding-helper <tool[,tool…]|all> [API key] [model ID] [options]
```

| Position | Meaning |
|---|---|
| Tool | Name or alias (`claude`, `codex`, `opencode`, `qwen`, `kimi`, `droid`, `grok`, `openclaw`, `mcode`, `copilot`, `codebuddy`, `workbuddy`, `hermes`), comma-separated; `all` means every installed tool |
| API key | Starts with `sk-`. If omitted: `QINIU_API_KEY`, then the saved key, then a hidden prompt in a terminal |
| `@profile` | e.g. `@work`: use that profile's key and endpoint; with a key in the same command, save it as that profile. If it is not the active profile, only these tools switch to it |
| Model ID | e.g. `deepseek/deepseek-v4-flash`. If omitted: the saved choice, or the first recommended model this key can use that supports tool calling. A missing vendor prefix (`deepseek-v4-pro`) is resolved automatically |

| Option | Meaning |
|---|---|
| `--intl` | Use the international endpoint; without it, a key rejected on the China endpoint is retried on the international one |
| `--dry-run` | Preview only |
| `--json` | JSON output (`endpoint`, `model`, `modelSource`, `toolModels`, per-tool results) |
| `--no-save` | Don't store the key and model in `~/.coding-helper/config.yaml`; only write tool configs |
| `--context <size>` | Context size limit, e.g. `128k`, `64k`, `200000`; `auto` uses the model maximum |

**Checks before writing:** an invalid key, a billing-suspended account, or a model that's unavailable or lacks tool calling stops the command (exit code 1) without touching any file, and tells you what to do next; a mistyped model gets a list of similar ones.

**Codex models:** Codex works through Qiniu's Responses API, so the command first sends one minimal request to confirm the model works there. GPT, Qwen, GLM and Kimi models work in testing; DeepSeek doesn't yet. Without a model, Codex uses `openai/gpt-6-astra`; when configured together with other tools, an incompatible model only skips Codex.

**Keeping the key safe:** a key typed into the command stays in your shell history (you'll get a reminder). Safer: `QINIU_API_KEY=sk-xxx npx qiniu-coding-helper codex`, or prefix the command with a space (most shells won't record it).

### ⚡ setup

```bash
# Interactive: tick tools (installed ones pre-ticked), choose models, write all
coding-helper setup

# Non-interactive: configure every installed tool (missing ones are "skipped")
coding-helper setup --yes

# Only these tools
coding-helper setup --tools claude,codex,opencode

# Preview: per-file diff with the key masked, nothing written
coding-helper setup --dry-run

# Scripts / CI: key from stdin (stays out of shell history), JSON output
echo "$QINIU_KEY" | coding-helper setup --key-stdin --yes --json
```

| Option | Meaning |
|---|---|
| `--tools a,b` | Only these tools, written even if not detected as installed |
| `-y, --yes` | No prompts, use saved models |
| `--dry-run` | Preview only: nothing written, no backups |
| `--json` | Machine-readable output |
| `--key-stdin` | Read and validate the API key from stdin |

**Exit codes:** `0` all succeeded (skipped because not installed doesn't count as failure), `2` some failed, `1` all failed.

Before writing, setup checks whether the account can actually call models. If the key is valid but the account is suspended for billing, you get a warning; the config is still written and works once you top up.

### 📋 status

```bash
coding-helper status          # table: tool, installed version, connected to Qiniu
coding-helper status --json
```

Status is read from each tool's real config files, so manual edits show up as they are.

### ↩️ restore

```bash
coding-helper restore              # every connected tool
coding-helper restore codex,qwen   # only these
coding-helper restore codex --yes  # no confirmation
```

Restore removes Qiniu's entries and writes back the values recorded before the first write: your previous `ANTHROPIC_BASE_URL`, Codex's default model, the OpenAI key in `auth.json`, Hermes's previous model and provider, and so on. Anything you added yourself afterwards is kept. Files that didn't exist before and were created by Coding Helper are deleted.

### 🚀 run

```bash
coding-helper run copilot                  # Copilot CLI has no config file, so this is how it's used
coding-helper run claude --continue        # arguments are passed through
coding-helper run claude -- --continue     # -- also works
```

Only the launched process gets the Qiniu env vars; no config file is touched, so your official account keeps working alongside. Exit codes and Ctrl+C are forwarded. Supports Claude Code and GitHub Copilot CLI.

### 🏥 doctor

```bash
coding-helper doctor
```

| Check | Meaning |
|---|---|
| Config file | Whether `~/.coding-helper/config.yaml` exists |
| API key | Whether the key is valid |
| Account | Whether models can actually be called — a billing-suspended account still passes the key check |
| Network | Whether the current endpoint is reachable |
| Each coding assistant | Installed version and whether it points to Qiniu |
| Shell env override | `ANTHROPIC_BASE_URL` and similar variables override Claude Code's settings file |
| Node.js, Git | Versions |

The account check sends one real request capped at 1 output token; on an active account it costs a tiny amount.

### 👤 profile: several keys / endpoints

A profile is one API key + one endpoint (China, international or a custom URL). Useful for work and personal accounts, switching regions, or giving one assistant a different account.

```bash
coding-helper profile add work sk-aaa                 # China endpoint; the first profile becomes active
coding-helper profile add personal sk-bbb --intl      # international endpoint
coding-helper profile add lab sk-ccc --base-url https://llm.example.com   # custom, Qiniu-compatible URL
coding-helper profile list                            # ● marks the active profile and lists tools using each
coding-helper profile use personal                    # switch: every connected tool moves to it
coding-helper profile use work codex                  # only Codex uses work
coding-helper codex @personal                         # pick a profile in one command
coding-helper run claude @lab                         # this launch only, no config files changed
coding-helper profile remove lab
```

<p align="center"><img src="docs/images/profiles.png" width="640" alt="Profiles page"></p>

**Codex can switch without Coding Helper.** Each profile gets a provider with its own key in `~/.codex/config.toml` and a `~/.codex/qn-<name>.config.toml` profile file (the Codex 0.134+ format), so you can run:

```bash
codex -p qn-work
codex -p qn-personal
```

`restore` removes those providers and files. The main menu's Profiles page can create, edit, delete and test profiles (`n` / `e` / `d` / `t`); press `p` on a tool's page to bind just that tool. Keys stay in `~/.coding-helper/config.yaml` (mode 0600) and are shown masked.

### 📐 Context size

Default is Auto: each model is written with its real maximum from Qiniu's model market. To cut cost or latency:

```bash
coding-helper codex,opencode --context 64k
```

or choose Auto / 128K / 64K / 32K / Custom in the main menu and then the tools to apply it to. The setting is stored per tool and only affects the tools you select; values above a model's maximum are capped. `--context` only affects the tools in that command.

| Written to | Assistants |
|---|---|
| `model_context_window` (original value restored on `restore`) | Codex |
| Their own context / input limit field | OpenCode, Qwen Code, Kimi Code CLI, Factory Droid, Grok CLI, OpenClaw, MiniMax Code, CodeBuddy, WorkBuddy |
| Not configurable (managed by the tool) | Claude Code, Hermes Agent, Copilot CLI |

### 🔄 After changing the key, endpoint or profile

In the menu, the tools still using the old settings are listed and you pick which to update (tools following the active connection are pre-selected; select none to only save). On the command line `auth <token>` and `profile use <name>` only save by default; add `--sync` to update connected tools, or run `auth reload <tool>` for one. Tools you have switched to another provider are never listed.

## 🔒 Safety

Coding Helper edits config files you use every day, so every write follows these rules:

- **Only Qiniu's own entries change.** Other providers, MCP servers, themes, sandbox policies stay as they are. TOML, `.env` and Hermes's YAML are edited line by line, keeping comments, blank lines, order and quoting; JSON keeps the original file's indentation and single-line / multi-line style.
- **Backup before writing.** Each run copies the files it will change into `~/.coding-helper/backups/<timestamp>/` with a `manifest.json` of original paths.
- **Atomic writes.** Write to a temp file, then replace, so a failure never leaves half a file; files are 0600, directories 0700.
- **Broken configs are never overwritten.** If your JSON / YAML can't be parsed, you get an error and the file stays as it is. An OpenClaw config with comments or trailing commas (JSON5) is also left alone.
- **Previous values are recorded for restore.** Before the first write, the values about to be replaced are saved in `~/.coding-helper/state.json`; `restore` writes them back. Running setup again never records Qiniu's own values as "previous".
- **Keys stay out of shell history.** Use the interactive prompt or `--key-stdin`; previews and logs mask the key. Qwen Code's key lives only in `.env`, and its settings file references the variable name.
- **Clearing config doesn't break restore.** "Clear Coding Helper Configuration" deletes only `config.yaml`; backups and recorded values stay, so `restore` still works.

In testing, 12 tools with existing user configs went through `setup` twice and then `restore`, and all 11 original config files came back byte for byte. Hermes's official 2333-line commented default config had exactly 4 lines changed.

## 🔧 Configuration

### Endpoints

| Endpoint | URL | For |
|---|---|---|
| 🇨🇳 China | `https://api.qnaigc.com` | Users in mainland China |
| 🌍 International | `https://api.modelink.ai` | Users elsewhere |
| 🔧 Custom URL | Your own | Self-hosted or proxy gateways (Qiniu-compatible) |

### Coding Helper's own files

| Path | Contents |
|---|---|
| `~/.coding-helper/config.yaml` | Language, endpoint, API key, model choices per tool, profiles, context size |
| `~/.coding-helper/state.json` | Connected tools and the values they replaced |
| `~/.coding-helper/backups/<timestamp>/` | Original files backed up before each write |

### What gets written per tool

<details>
<summary><b>Claude Code</b></summary>

`env` in `~/.claude/settings.json`, plus the onboarding flag in `~/.claude.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.qnaigc.com",
    "ANTHROPIC_AUTH_TOKEN": "<your-api-key>",
    "API_TIMEOUT_MS": "3000000",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "<chosen model>"
  },
  "companyAnnouncements": ["您正在使用七牛云 AI 大模型推理服务 🚀"],
  "attribution": { "commit": "", "pr": "" }
}
```

The 50-minute timeout suits long reasoning requests; non-essential traffic and attribution are turned off to improve cache hit rates through the gateway. Shell variables such as `ANTHROPIC_BASE_URL` override these settings — `doctor` detects them.

</details>

<details>
<summary><b>Codex</b></summary>

Updates the top-level `model`, `model_provider` and `model_catalog_json` in place in `~/.codex/config.toml` and adds these two tables; MCP servers, sandbox policy and other providers are kept:

```toml
[model_providers.qnaigc]
name = "Qiniu"
base_url = "https://api.qnaigc.com/bypass/openai/v1"
requires_openai_auth = true
wire_api = "responses"

[profiles.qn-gpt]
model_provider = "qnaigc"
model = "openai/gpt-6-astra"
```

The key goes to `~/.codex/auth.json` and the Qiniu GPT catalog to `~/.codex/model-catalogs/qnaigc.json`. Restore writes back the replaced top-level keys and the OpenAI key previously in `auth.json`.

</details>

<details>
<summary><b>OpenCode / Qwen Code / Kimi Code CLI / Factory Droid</b></summary>

All use Qiniu's OpenAI-compatible API at `https://api.qnaigc.com/v1`:

- **OpenCode:** `provider.qiniu` (`@ai-sdk/openai-compatible`) and `model` set to `qiniu/<model>`.
- **Qwen Code:** a Qiniu entry in `modelProviders.openai` (`envKey: QINIU_API_KEY`), plus `security.auth.selectedType` and `model.name`; the key goes to `~/.qwen/.env`.
- **Kimi Code CLI:** `[providers.qiniu]` (`type = "openai"`), `[models."qiniu/<model>"]` and `default_model`. Honors `KIMI_CODE_HOME`.
- **Factory Droid:** a `customModels` entry named `Qiniu: <model>` (`generic-chat-completion-api`); restore removes only entries with that prefix.

Context and output limits come from the Qiniu marketplace, with conservative defaults if that lookup fails.

</details>

<details>
<summary><b>Grok CLI / OpenClaw / MiniMax Code</b></summary>

- **Grok CLI:** `[model.qiniu]` (`api_backend = "chat_completions"`) in `~/.grok/config.toml`, with `[models] default` pointing to it. Honors `GROK_HOME`.
- **OpenClaw:** `models.providers.qiniu` (`api: openai-completions`) and `agents.defaults.model.primary` in `~/.openclaw/openclaw.json`; if you use a model allowlist, the Qiniu model is added to it.
- **MiniMax Code:** its config format isn't documented, so the official `mcode provider add --use` is used (it runs a connection test first and saves nothing if that fails). Restore removes `custom_provider.qiniu` and writes back the previous `defaultModel`.

</details>

<details>
<summary><b>CodeBuddy / WorkBuddy / Hermes Agent</b></summary>

- **CodeBuddy / WorkBuddy:** `vendor: "Qiniu"` model entries in `models.json` (full `/v1/chat/completions` URL) and `availableModels` kept in sync; other vendors' entries and fields are untouched. If previously chosen models were delisted: partially missing ones trigger a warning and the rest are written; if all are gone, it errors and leaves the file alone.
- **Hermes Agent:** only the `provider`, `default`, `base_url` and `api_key` lines under `model` in `~/.hermes/config.yaml` change; everything else, comments included, stays.

</details>

These files store the API key in plain text (except Qwen Code, which uses `.env`) — treat them like password files.

## ❓ FAQ

<details>
<summary><b>The tool still doesn't use Qiniu after setup</b></summary>

1. Run `coding-helper doctor` and check "Shell env override". Variables such as `ANTHROPIC_BASE_URL` override config files; remove them from `~/.zshrc` / `~/.bashrc` and reopen the terminal.
2. Run `coding-helper status` and confirm the tool shows "● Connected to Qiniu"; if not, run `coding-helper setup --tools <tool>`.
3. Quit and restart the tool completely.

</details>

<details>
<summary><b>The key is valid but calls fail (e.g. 403 / account_billing_suspended)</b></summary>

A billing-suspended account still passes the key check, but every model call fails. `coding-helper doctor` reports it under "Account". Top up in the [Qiniu console](https://portal.qiniu.com/); it can take a few minutes to recover.

</details>

<details>
<summary><b>Codex says the model is unavailable</b></summary>

Codex is fixed to `openai/gpt-6-astra`. Make sure your account can use GPT models (check with `coding-helper doctor` or in the Qiniu console).

</details>

<details>
<summary><b>Kimi says "Found the legacy kimi-cli"</b></summary>

The old pip-installed `kimi-cli` (1.x) reads `~/.kimi`. Install the new Kimi Code instead: `npm install -g @moonshot-ai/kimi-code`.

</details>

<details>
<summary><b>OpenClaw says the config is JSON5</b></summary>

If `~/.openclaw/openclaw.json` contains comments or trailing commas, Coding Helper won't rewrite it so your comments aren't lost. Remove them and retry.

</details>

<details>
<summary><b>MiniMax Code setup fails</b></summary>

MiniMax Code runs a connection test before saving. Make sure the key is valid, the account isn't suspended, and the chosen model is available on your account.

</details>

<details>
<summary><b>Undoing a specific change</b></summary>

Prefer `coding-helper restore`. To get back a complete original file from before a particular write, look in `~/.coding-helper/backups/<timestamp>/`; `manifest.json` lists each backup's original path.

</details>

<details>
<summary><b>Is Gemini CLI supported?</b></summary>

Not yet. Gemini CLI only speaks the native Gemini protocol (`/v1beta`), which Qiniu endpoints don't serve yet.

</details>

---

## 🛠️ Development

```bash
pnpm install        # install dependencies
pnpm build          # tsc + copy locales to dist/
pnpm test           # build and run node:test (CI runs Node 18 / 20 / 22)
pnpm dev            # watch mode
pnpm start          # run the CLI (node dist/cli.js)
```

Layout:

| Directory | Responsibility |
|---|---|
| `src/commands/` | Subcommands (setup, status, restore, run, auth, doctor, lang) |
| `src/lib/core/` | Safe writes and backups, recorded previous values, line-level TOML / YAML / .env editing, apply and sync service |
| `src/lib/tools/` | One adapter per coding assistant; OpenAI-compatible clients extend `OpenAICompatTool` |
| `src/lib/wizard/` | Interactive wizard, menus and terminal rendering |

Adding a coding assistant: implement `ITool` in `src/lib/tools/` (extend `OpenAICompatTool` if it's OpenAI-compatible), register it in `tool-manager.ts`, and add a write → restore round-trip test in `tests/`.

---

## 📄 License

[AGPL-3.0](LICENSE)
