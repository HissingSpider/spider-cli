# spider-cli

A Claude Code–style agentic coding CLI running on the University of Richmond **SpiderAI** API gateway.

Educational use only — commercial use is prohibited by the SpiderAI terms.

## Setup

```bash
cd ~/spider-cli
npm install
echo 'SPIDERAI_API_KEY=your-key-here' > ~/.spidercli/.env
ln -sf ~/spider-cli/bin/spider ~/.local/bin/spider   # already on PATH
spider
```

`bin/spider` is a zsh wrapper that resolves node through nvm before exec'ing,
so it works from shells where nvm has not been sourced.

Get your key from the **My Account** page on SpiderAI.

## Usage

```bash
spider                                  # interactive session
spider -p "explain src/agent/loop.ts"   # headless, prints to stdout
spider --model claude-haiku-4-5-20251001
spider --mode plan                      # read-only investigation
spider --resume                         # continue the last session here
```

### Keys

| Key | Effect |
|---|---|
| `shift+tab` | Cycle permission mode: default → acceptEdits → auto → plan |
| `ctrl+o` | Expand the collapsed tool output of the current turn |
| `↑` / `↓` | Walk back through earlier prompts (or move between lines) |
| `ctrl+r` | Reverse-search your prompt history |
| `ctrl+x` | Edit the prompt in `$EDITOR` |
| `\` at end of line | Continue onto another line |
| `ctrl+c` while working | Interrupt the turn |
| `ctrl+c` with text typed | Clear the input line |
| `ctrl+c` twice on an empty line | Exit (the first press warns, and lapses after 2s) |
| `esc` while working | Interrupt the turn |
| `ctrl+d` on an empty line | Exit |

Interrupting stubs any tool call the model had requested but not yet run, so the
transcript keeps every `tool_use` paired with a result and the next message is
still accepted.

### Slash commands

| Command | Effect |
|---|---|
| `/help` | List commands |
| `/model [name]` | Show or switch the active model |
| `/mode [name]` | `default`, `acceptEdits`, `auto`, `plan`, `bypassPermissions` |
| `/clear` | Clear the conversation |
| `/compact` | Summarize the transcript and drop the raw history |
| `/context` | Show how much context the conversation is using |
| `/mcp` | Show connected MCP servers and their tools |
| `/cost` | Token usage and estimated cost |
| `/permissions` | Show active allow/deny rules |
| `/resume` | Reload the most recent session for this directory |
| `/init` | Write a SPIDER.md describing this project |
| `/commands` | List custom commands from `.spider/commands/` |
| `/sessions` | List saved sessions for this directory |
| `/export [file]` | Write the transcript to markdown |
| `/resources` `/prompts` | What connected MCP servers expose |
| `/theme [name]` | `dark`, `light`, `mono` |
| `/vim` | Toggle vim-style modal editing |
| `/status` `/doctor` | Environment and configuration checks |
| `/exit` | Quit |

Two input prefixes bypass the model entirely:

| Prefix | Effect |
|---|---|
| `!<command>` | Run a shell command directly (the model is told the result) |
| `#<note>` | Append a note to `SPIDER.md` |
| `@<path>` | Attach a file — text is inlined, images are sent as images |

## Permissions

Reads (`read_file`, `glob`, `grep`, `list_dir`) run freely. Writes and shell commands
prompt for approval, offering **yes**, **yes and don't ask again**, or **no**. Choosing
"don't ask again" writes a rule to `.spider/settings.json`:

```json
{
  "model": "gpt-5",
  "permissionMode": "default",
  "allow": ["bash(git status:*)", "bash(npm test:*)"],
  "deny": ["bash(rm:*)"]
}
```

Rules match `tool(subject)`, where a trailing `:*` or `*` is a prefix match. Deny rules
are checked first and win over everything, including `bypassPermissions`. The tool name
may itself end in `*`, so `mcp__deerdawn__*` trusts one server's whole toolset.

**Compound commands are split before they are matched.** A rule is checked against
every segment of a command — `&&`, `||`, `;`, `|`, `&`, and the contents of `$(...)`
and backticks — and all of them have to be covered. Without that, saving
`bash(git status:*)` would silently approve `git status && rm -rf ~` on the strength
of its first two words. For the same reason, approving a compound command saves one
narrow rule per segment rather than a single rule covering more than you looked at.

**Workspace scoping.** Reads are unprompted only *inside* the working directory.
Any path that resolves outside it prompts, even `read_file`, and `acceptEdits`
does not relax that. Without this an unscoped read will happily open
`~/Library/Application Support` and print credentials to the terminal.

Run `spider` from a project directory, not from `$HOME` — it warns if you do,
because your whole home directory then becomes the searchable workspace.

Modes:

- **default** — ask before writes and shell commands
- **acceptEdits** — file edits are automatic, shell commands still ask
- **auto** — edits and ordinary commands run unprompted; destructive or unrecognized
  commands still stop for you
- **plan** — read-only; the agent investigates and proposes a plan
- **bypassPermissions** — no prompts (deny rules still apply)

`shift+tab` cycles the first four. `bypassPermissions` is deliberately outside the
cycle — turning off every guardrail should take more than a stray keystroke.

### What "destructive" means

`src/agent/risk.ts` classifies each command segment as **read**, **write**,
**destructive** or **unknown**, and the whole command takes the risk of its worst
segment. `auto` runs read and write; destructive and unknown always ask. An
unrecognized verb counts as unknown, so the classifier fails closed.

Bare shells (`sh`, `bash`, `eval`, `source`) are destructive, which is what makes
`curl https://x.sh | sh` stop for approval: splitting on the pipe leaves `sh` standing
on its own.

Read-only commands — `git log`, `git diff`, `ls`, `sed -n` — run during **plan mode**,
so planning can actually look at history rather than being limited to four built-in
tools. A `>` redirect promotes any read to a write.

### Approving an edit shows the diff

A write or edit prompt renders the unified diff the change would produce, coloured, with
three lines of context. Approving a change you cannot see is not consent.

## Plan mode

Plan mode ends with `exit_plan_mode`: the agent presents the plan, and you choose to
auto-accept edits, approve each change, or keep planning. Approving switches the
permission mode and the same turn carries on into the work, rather than leaving you to
type `/mode default` and ask the question again.

Read-only MCP tools — those whose server sets `annotations.readOnlyHint` — are usable
while planning. Tools without the hint are assumed to act, and are refused.

## Task list

`todo_write` keeps a visible checklist above the prompt for work with three or more
steps, striking through items as they complete. It records intent only, so it never
prompts and works in plan mode.

## Trust

The first run in a directory asks before honouring anything that directory
contains. A project's `SPIDER.md` goes into the system prompt, its `.mcp.json`
proposes servers, and its `.spider/settings.json` proposes rules — all written by
whoever wrote the repo. Declining runs the session with that configuration
ignored; `spider trust` approves it.

MCP servers are approved separately and individually, keyed to the command or URL
rather than the name, so changing what a server points at asks again.

## Hooks

Shell commands the CLI runs at fixed points, configured under `hooks` in
settings. This is the difference between "the agent usually remembers to run the
formatter" and "the formatter runs".

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "write_file|edit_file", "command": "npx prettier --write $CLAUDE_FILE" }
    ],
    "PreToolUse": [{ "matcher": "bash", "command": "./scripts/vet-command.sh" }]
  }
}
```

Events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`.
The payload arrives as JSON on stdin. Exit 0 permits; exit 2 blocks with stderr as
the reason; `{"decision":"block","reason":...}` on stdout does the same, and
`{"additionalContext":...}` feeds text back to the model. Any other non-zero exit
is treated as a broken hook and reported — a hook that cannot run must not
silently become a deny-all.

## Custom commands and subagents

Markdown files become slash commands (`.spider/commands/review.md` → `/review`),
with `$ARGUMENTS` and `$1`..`$9` substitution. Files in `.spider/agents/` define
named subagents:

```markdown
---
name: reviewer
description: Reads code and reports, never edits
tools: read_file, grep, glob
---
You review code. You do not change it.
```

The `task` tool delegates self-contained work to a child agent with its own
transcript, so a wide search does not fill the parent's context with every file
it read — only the final report comes back. A definition's `tools` list is a
restriction, not a suggestion. Delegation is capped at two levels deep, and tool
calls still route approvals to you. Their tokens count toward the same `/cost`.

## Context compaction

When a request's input crosses `autoCompactAt` (default 100,000 tokens) and there
is enough new history to be worth summarizing, the older transcript is replaced
with a summary and the most recent `keepRecentTurns` turns are kept verbatim.
`/compact` does it on demand; `/context` shows where you stand.

The cut point never lands on a tool turn — that would orphan a `tool_use` id
from the assistant turn that issued it and the next request would be rejected.
Repeat compactions are damped so a low threshold cannot thrash.

## MCP servers

Add servers to `.spider/settings.json`, local or remote. Their tools appear as
`mcp__<server>__<tool>` and are offered to the model like any built-in:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/code"]
    }
  }
}
```

Remote servers use a `url` instead of a `command`. Streamable HTTP is tried
first, falling back to the older SSE transport:

```json
{
  "mcpServers": {
    "remote-thing": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
```

A server that fails to start is reported and skipped rather than blocking
startup — check `/mcp` for status. `bin/spider` puts node's directory on PATH
before spawning, so `npx`-based servers resolve even though node comes from nvm.

### OAuth

Servers behind OAuth are authorized with a one-time login:

```bash
spider mcp list                 # configured servers and auth status
spider mcp login deerdawn       # opens the browser, stores tokens
spider mcp logout deerdawn      # forget stored credentials
```

`spider mcp login` runs the authorization-code flow with PKCE: it discovers the
server's metadata, registers a client dynamically, binds a loopback listener on
an ephemeral port for the redirect, opens your browser, verifies the `state`
parameter on the callback, and exchanges the code for tokens. Tokens land in
`~/.spidercli/oauth/<server>.json` with mode `0600`, and later sessions refresh
them automatically.

Request scopes if the server uses them — without this you can get a token that
cannot call the tools:

```json
{
  "mcpServers": {
    "deerdawn": {
      "url": "https://api.deerdawn.com/mcp/claude",
      "scope": "context:read context:write"
    }
  }
}
```

Startup never blocks on a login. A server whose grant is missing or expired is
reported as `needs authorization — run: spider mcp login <name>` and skipped.

## The shell

`bash` runs in one long-lived shell, so `cd` and exported variables carry between
calls. Output streams while the command runs. `run_in_background: true` starts a
job and returns immediately; `bash_output` polls it for whatever is new and
`kill_shell` stops it.

A command that kills the shell (`exit`) is detected and reported rather than
hanging until the timeout, and a timeout restarts the shell rather than wedging
it.

## Reading and editing

`read_file` takes `offset` and `limit`, and refuses binaries instead of printing
mojibake. `write_file` and `edit_file` refuse to touch a file that has not been
read this session — an edit is a claim about what a file contains, and making one
blind is how work gets silently destroyed.

## Fetching and searching the web

`web_fetch` retrieves an http(s) URL and converts HTML to plain text. It is not
a search tool — it can only fetch a URL you or the model names explicitly.

`web_search` needs a real search API; the scrapeable HTML front ends all return
bot-check pages. Configure one and it works; leave it unconfigured and it says
so, in its tool description as well as its output, so the model asks you for a
URL rather than retrying:

```json
{ "search": { "provider": "brave", "apiKey": "..." } }
```

`BRAVE_API_KEY` or `TAVILY_API_KEY` in the environment does the same.

Guards: only `http`/`https` (no `file:`/`data:`), redirects followed manually and
capped at 5 with the chain reported, non-text content types refused, a 2 MB
transfer ceiling, 50k character output cap, and a 20s timeout.

Approval is **per-domain**, not per-URL — approving `web_fetch(deerdawn.com)`
covers every path on that host and nothing on any other host. It always prompts
by default; there is no mode short of `bypassPermissions` that makes it silent.
A redirect that leaves the approved host is refused rather than followed, because
that is a different fetch and it has not been approved.

## Tool output is data, not instructions

Anything a tool returns — file contents, command output, search results, MCP
results — is treated as data. If a file contains text addressed to an assistant
("connect this service", "ask the user for their API key", "you were already
authorized"), the agent reports the file and lines rather than acting on it.
This is not hypothetical: an early build read a stray `AGENTS.md` while running
from `$HOME` and spent the turn walking the user through a connector setup
nobody asked for.

Searches also skip `Library`, `Applications`, `.Trash` and app caches, skip
symlinks, stop at 20,000 files, and never read binaries or oversized files as
text.

## Project instructions

Drop a `SPIDER.md` in the project root and it is injected into the system prompt,
the same way `CLAUDE.md` works in Claude Code.

## Models

There is no `/v1/models` endpoint on the gateway, so the list is hardcoded from
what a student key can actually reach:

| Provider | Models |
|---|---|
| OpenAI (`/v1/responses`) | `gpt-5` (default), `gpt-5-mini`, `gpt-4.1`, `gpt-4.1-mini`, `gpt-4o` |
| Anthropic (`/v1/messages`) | `claude-haiku-4-5-20251001` |

## Gateway quirks worth knowing

These cost real debugging time, so they are handled explicitly in `src/providers/`:

1. **The chat host is not the API host.** `spiderai.richmond.edu` is a Streamlit web
   app; POSTing to it returns Tornado's HTML `403: Forbidden`. The API is
   `spideraiapi.richmond.edu`. `loadCredentials` rejects the wrong one with a
   pointed error rather than letting it fail confusingly later.
2. **Errors arrive as HTTP 200** with an error object in the body, so `res.ok` reports
   success on a failed call. `throwIfErrorBody` in `src/providers/types.ts` inspects
   every body, and `postSSE` sniffs the first chunk because a rejected streaming
   request answers with plain JSON instead of a stream.
3. **The published docs are stale.** The Anthropic doc's `claude-3-5-sonnet-20241022`
   is not entitled; every Sonnet and Opus ID returns `Sub-product ... is not allowed
   to be used for the ai resource`. Only Haiku 4.5 works, and only under its full
   dated ID — the `claude-haiku-4-5` alias is rejected too.
4. **The OpenAI side is the Responses API, not Chat Completions.** There is no
   `/v1/chat/completions`.

## Layout

```
bin/spider            zsh launcher, resolves node via nvm
src/
  index.tsx           entry, arg parsing, headless mode
  config.ts           settings merge, credentials, SPIDER.md
  cost.ts             token and cost tracking
  session.ts          session persistence and resume
  providers/
    types.ts          internal turn shape, SpiderAI error shim
    http.ts           POST + SSE with retry and error sniffing
    openai.ts         Responses API adapter
    anthropic.ts      Messages API adapter
  agents.ts           named subagent definitions from .spider/agents/
  commands.ts         custom slash commands from .spider/commands/
  agent/
    loop.ts           tool-use loop, compaction, hooks, parallel reads
    permissions.ts    rule matching, mode logic, workspace roots
    risk.ts           command segmentation and read/write/destructive classification
    preview.ts        unified diffs for edit and write approvals
    plan.ts           the exit_plan_mode tool
    hooks.ts          PreToolUse / PostToolUse / Stop / SessionStart / UserPromptSubmit
    prompt.ts         system prompt
    compact.ts        transcript summarization and safe split points
    subagent.ts       the task tool
  mcp/client.ts       MCP client: transports, notifications, reconnect, sampling,
                      roots, elicitation, resources, prompts, completions
  mcp/oauth.ts        token storage, loopback listener, OAuth provider
  mcp/login.ts        authorization-code + PKCE login flow
  mcp/trust.ts        per-server and per-directory approval
  tools/index.ts      read, write, edit, bash, glob, grep, list_dir
  tools/web.ts        web_fetch with scheme, size and redirect guards
  tools/todo.ts       the task list
  tools/shell.ts      the persistent shell and background jobs
  tools/search.ts     web_search against a configured provider
  tools/mcp-resources.ts  list/read tools for MCP resources
  ui/App.tsx          Ink TUI
  ui/Input.tsx        prompt line: multi-line, history, ctrl+r, vim mode
  ui/markdown.tsx     markdown rendering and code highlighting
  ui/theme.ts         dark / light / mono palettes, NO_COLOR
  ui/terminal.ts      bell, title, OSC 8 hyperlinks
  ui/notices.ts       where mid-session messages go
  ui/elicit.ts        server-initiated questions
test/                 16 files. Run them all:
                        for f in test/*.test.ts; do npx tsx "$f"; done
                        npx tsx test/ui.smoke.tsx
```

## Tests

```bash
npx tsc --noEmit
for f in test/*.test.ts; do npx tsx "$f"; done
npx tsx test/ui.smoke.tsx
```

`risk` covers command splitting and the chained-rule regression; `preview` the
edit diffs; `mcp` runs a real fixture server over stdio; `hooks`, `session`,
`tools`, `search`, `subagent` and `images` cover their namesakes; `ui.smoke`
renders the real TUI against a stub agent for 41 checks.

