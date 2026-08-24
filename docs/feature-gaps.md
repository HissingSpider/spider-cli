# spider-cli — feature gap list

> **Status: complete.** All 74 items shipped, with 16 test files covering them
> (`risk`, `preview`, `todo`, `mcp`, `hooks`, `session`, `tools`, `search`,
> `subagent`, `images`, `permissions`, `compact`, `web`, `interrupt`, `oauth`,
> and 41 checks in `ui.smoke`). `npx tsc --noEmit` is clean.
>
> Two items did not land the way the card described, and the deviation is
> deliberate — see the notes at #29 and #56.

Baseline: v0.1.0, 2,987 lines across `src/`. MCP (stdio/HTTP/SSE + OAuth) and four
permission modes already ship. What follows is what is *missing* to reach Claude Code
parity, grouped by area, with file references where the gap has a concrete home.

---

## 1. MCP — protocol coverage

The client speaks exactly one capability: `tools`. Everything else in the spec is absent.

1. **[DONE]** **Resources** — no `resources/list`, `resources/read`, no `@server:resource` mention
   syntax to attach a resource to a prompt, no resource subscriptions.
2. **[DONE]** **Prompts** — no `prompts/list`. Server-provided prompts should surface as slash
   commands (`/mcp__deerdawn__brief`); today they are invisible.
3. **[DONE]** **Sampling** — `new Client({...}, { capabilities: {} })` (`src/mcp/client.ts:137`)
   declares nothing, so a server can never ask the CLI to run an LLM call on its behalf.
4. **[DONE]** **Roots** — the workspace root is never advertised, so filesystem-style servers cannot
   scope themselves to the project.
5. **[DONE]** **Elicitation** — no support for a server asking the user a structured question.
6. **[DONE]** **Completions** — no `completion/complete` for argument autocomplete.
7. **[DONE]** **Notifications** — no `setNotificationHandler` anywhere. `tools/list_changed`,
   `resources/updated`, and `logging/message` are all dropped. Tools are listed once at
   connect (`collectTools`, `src/mcp/client.ts:89`) and never refreshed, so a server that
   gains a tool mid-session is invisible until restart.
8. **[DONE]** **Non-text content** — `textOf` (`src/mcp/client.ts:76`) renders images, audio, and
   resource links as the literal string `[image content]`. No vision passthrough.

### MCP operations & ergonomics

9. **[DONE]** **No connect timeout, and connection is serial.** `connectServers` awaits each server
   in a `for...of` (`src/mcp/client.ts:135`). One hanging stdio server blocks the TUI from
   ever rendering. Needs `Promise.allSettled` + a per-server deadline.
10. **[DONE]** **No reconnect.** A dropped transport leaves dead tool entries in `agent.tools` that
    fail on every call for the rest of the session.
11. **[DONE]** **`stderr: 'ignore'`** (`src/mcp/client.ts:179`) throws away the only diagnostic a
    broken stdio server produces. Capture it and show it in `/mcp`.
12. **[DONE]** **No lazy connection / no enable-disable.** Every configured server starts on every
    launch, even for a one-line question.
13. **[DONE]** **Tool-list budgeting.** Every MCP tool is injected into every request
    (`Agent.specs()`, `src/agent/loop.ts:89`). Three servers at 30 tools each blows the
    context window and degrades tool selection. Needs deferred schemas / a tool-search
    layer, or at minimum per-server tool filtering in settings.
14. **[DONE]** **No `spider mcp add`.** Servers must be hand-written into `.spider/settings.json`.
    No `.mcp.json` project convention, no import from an existing Claude Desktop config.
15. **[DONE]** **No trust prompt on first connect** — no "this server can read X, allow?" gate.
16. **[DONE]** **No health/latency in `/mcp`** — status is a one-shot snapshot from startup
    (`mcpStatus` is passed frozen into `App`, `src/index.tsx:218`) and never updates.

### MCP × permissions

17. **[DONE]** **MCP tools have no permission vocabulary.** `subjectOf` (`src/agent/permissions.ts:49`)
    returns `input.path ?? input.pattern ?? ''` — for most MCP tools that is the empty
    string, so `suggestedRule` produces `mcp__server__tool()` and there is no way to write
    `mcp__server__*` to trust a whole server, and no way to mark a read-only MCP tool as
    free.

---

## 2. Modes — plan, auto, normal

Existing: `default`, `acceptEdits`, `plan`, `bypassPermissions`, set via `/mode` or `--mode`.

18. **[DONE]** **No `auto` mode.** This is the missing tier. Auto should approve edits *and*
    non-destructive commands, prompting only for risky ones — which requires a **command
    risk classifier** that does not exist. Today `bash` is all-or-nothing: `git log` and
    `rm -rf` get identical treatment.
19. **[DONE]** **No shift+tab mode cycling.** The signature Claude Code interaction. `useInput`
    (`src/ui/App.tsx:103`) handles ctrl+c/ctrl+d/esc only. Mode changes require typing a
    slash command.
20. **[DONE]** **No mode banner.** Mode appears as plain dim text in the footer
    (`src/ui/App.tsx:406`). Claude Code shows a persistent colored indicator
    (`⏵⏵ accept edits on`, `⏸ plan mode on`) that makes the current authority unmissable.
21. **[DONE]** **Plan mode has no exit ritual.** This is the biggest plan-mode gap. There is no
    `exit_plan_mode` tool and no "here is the plan — approve to proceed?" prompt. The
    agent presents a plan, and the user must manually `/mode default` and re-ask.
    Approving a plan should flip the mode and continue the same turn.
22. **[DONE]** **Plan mode disables every MCP server.** `READ_ONLY` is a hardcoded set of four names
    (`src/agent/permissions.ts:13`); plan mode denies anything not in it
    (`src/agent/permissions.ts:93`). So every `mcp__*` tool — including purely read-only
    ones — and `web_fetch` are blocked during planning, which is exactly when you want to
    read from them.
23. **[DONE]** **Plan mode blocks read-only bash.** `git log`, `git diff`, `ls` are all denied.
    Needs the same risk classifier as item 18.
24. **[DONE]** **Mode is not persisted.** `SavedSession` (`src/session.ts:8`) stores id, cwd, model,
    turns — not mode, and not session-learned allow rules. `--resume` restores the
    transcript but silently drops you back to `default`.
25. **[DONE]** **No per-directory trust prompt** on first run in an unfamiliar folder.

---

## 3. Visual & UX flourishes

The current TUI is an Ink `Static` list, a one-line spinner, and a bordered approval box.
This section is where the distance from Claude Code is largest.

26. **[DONE]** **No markdown rendering.** Assistant text prints raw — `**bold**`, `#` headings, and
    ``` fences appear literally (`src/ui/App.tsx:344`). Single highest-impact visual fix.
27. **[DONE]** **No syntax highlighting** in code blocks.
28. **[DONE]** **No diff rendering.** The approval preview for an edit is `edit_file → path`
    (`previewOf`, `src/agent/permissions.ts:61`). The user approves file changes *sight
    unseen*. Claude Code shows a colored unified diff before approval and after write.
    This is a safety gap as much as a visual one.
29. **[DONE]** **No collapsible tool output.** Every tool result dumps its first 12 raw lines
    (`src/ui/App.tsx:174`), always. No `⎿ Read 214 lines (ctrl+o to expand)` summary line,
    no expand toggle, no full-transcript view.
30. **[DONE]** **No elapsed timer or live token counter** on the spinner — just `working…`
    (`src/ui/App.tsx:395`). No rotating status verbs.
31. **[DONE]** **No reasoning/thinking display.** The OpenAI Responses API emits reasoning summaries;
    nothing surfaces them.
32. **[DONE]** **Cannot queue input while busy.** The `TextInput` is *replaced* by the spinner
    (`src/ui/App.tsx:390`), so you cannot type your next message until the turn ends.
33. **[DONE]** **No slash-command autocomplete.** Commands are matched by exact string in a `switch`
    (`src/ui/App.tsx:217`). No menu, no fuzzy match, no argument hints.
34. **[DONE]** **No `@file` mention autocomplete** to attach files to a prompt.
35. **[DONE]** **No `!` bash passthrough** and no `#` memory-append prefix.
36. **[DONE]** **No multi-line input.** No shift+enter, no `\` continuation, no ctrl+x external
    editor, no large-paste collapsing (`[Pasted 340 lines]`).
37. **[DONE]** **No prompt history.** Up-arrow does nothing; `ink-text-input` is used bare.
38. **[DONE]** **No ctrl+r reverse search**, no `esc esc` to rewind and fork from an earlier message.
39. **[DONE]** **No todo/task panel.** No `TodoWrite` equivalent — the mechanic that makes a
    twenty-step task legible while it runs.
40. **[DONE]** **No startup banner.** `console.log` of three plain lines before `render()`
    (`src/index.tsx:205`). No boxed panel, no tips, no version/update check.
41. **[DONE]** **No theme system.** Colors are hardcoded literals. No light/dark, no 16-color
    fallback, no `NO_COLOR`, no terminal-width awareness — the fixed two-space indent on
    tool output (`src/ui/App.tsx:355`) wraps badly on narrow terminals.
42. **[DONE]** **No context meter.** `/context` prints a sentence on demand
    (`src/ui/App.tsx:233`); there is no always-visible percentage bar and no warning as
    you approach `autoCompactAt`.
43. **[DONE]** **No cost in the footer** — `/cost` only.
44. **[DONE]** **No streaming tool output.** `execAsync` buffers to completion
    (`src/tools/index.ts:~213`), so a two-minute test run shows nothing until it finishes.
45. **[DONE]** **No retry/backoff visibility** — no "connection lost, retrying 2/5".
46. **[DONE]** **No terminal integration flourishes**: no bell/OSC 9 notification on completion, no
    OSC 8 hyperlinks on file paths, no OSC 133 prompt marks, no window-title updates.
47. **[DONE]** **No image input** — cannot paste a screenshot.
48. **[DONE]** **No `/export`**, no copy-last-response, no scrollback control.
49. **[DONE]** **No vim keybindings**, no configurable keybindings.
50. **[DONE]** **No `/status` or `/doctor`** diagnostics.

---

## 4. Agent & tool capability

51. **[DONE]** **No persistent shell.** Each `bash` call is a fresh `execAsync`
    (`src/tools/index.ts:~211`), so `cd` and exported env vars do not survive between
    calls. A frequent and confusing failure mode.
52. **[DONE]** **No background processes.** Hard 120s timeout, no `run_in_background`, no output
    polling, no kill.
53. **[DONE]** **No parallel tool execution.** `run()` iterates tool calls in a sequential `for...of`
    (`src/agent/loop.ts:235`) even when the model requests independent reads.
54. **[DONE]** **`read_file` has no offset/limit** (`src/tools/index.ts:112`) — a 4,000-line file
    lands in the transcript whole. No image, PDF, or notebook reading.
55. **[DONE]** **No read-before-edit enforcement.** Nothing tracks which files the agent has read;
    `write_file` will silently clobber a file it has never seen.
56. **[DONE]** **No WebSearch.** Acknowledged in the system prompt as a limitation
    (`src/agent/prompt.ts:20`) — still a real capability gap.
57. **[DONE]** **Subagents are one-dimensional.** One generic type (`src/agent/subagent.ts`), no
    named agent definitions, no parallel spawning, no background subagents, no depth > 1.
58. **[DONE]** **`MAX_ITERATIONS = 25`** (`src/agent/loop.ts:13`) stops with a notice and no
    auto-continue.
59. **[DONE]** **No prompt caching** — the full system prompt and tool list are re-sent every round.

---

## 5. Extensibility

60. **[DONE]** **No hooks.** No `PreToolUse` / `PostToolUse` / `Stop` / `SessionStart`. This is the
    entire automation surface, and its absence blocks lint-on-edit, test-on-save, and
    custom guardrails.
61. **[DONE]** **No custom slash commands** from `.spider/commands/*.md`.
62. **[DONE]** **No skills, no plugins, no agent definitions.**
63. **[DONE]** **No `settings.local.json`** for personal, un-committed allow rules —
    `persistAllowRule` (`src/config.ts:87`) writes straight into the shared project file
    that gets committed.
64. **[DONE]** **No `--allowedTools` / `--disallowedTools` / `--add-dir` flags**, no `--settings`,
    no managed/enterprise policy layer.
65. **[DONE]** **`SPIDER.md` is shallow.** Only two fixed paths, project root only
    (`src/config.ts:122`). No `~/.spidercli/SPIDER.md` user layer, no walk up the tree,
    no subdirectory discovery, no `@path` imports, no `/init` to generate one.

---

## 6. Sessions & headless

66. **[DONE]** **Whole-transcript rewrite on every turn.** `save()` serializes all turns to one JSON
    file (`src/session.ts:20`) after each turn — no JSONL append, no crash safety, no
    size bound.
67. **[DONE]** **`--resume` takes no argument** (`src/index.tsx:35`) — it is always "most recent in
    this directory". No picker UI, no `--continue` vs `--resume <id>`, no forking.
68. **[DONE]** **No session titles or summaries** — sessions are identified by an ISO timestamp
    (`src/session.ts:16`).
69. **[DONE]** **Headless is text-only.** No `--output-format json|stream-json`, no
    `--input-format stream-json`, no `--max-turns`, no `--append-system-prompt`, no
    emitted session id for chaining, and no meaningful exit codes.
70. **[DONE]** **Headless refuses all approvals outright** (`src/index.tsx:186`) rather than
    honouring a supplied allowlist.

---

## 7. Correctness issues found while reading

Not "missing features" — these are live defects worth fixing before building on top.

71. **[DONE]** **The bash allow-rule is prefix-matched against the whole command string.**
    `suggestedRule` records the first two words as `bash(git status:*)`
    (`src/agent/permissions.ts:71`), and `matchesRule` tests
    `subject.startsWith('git status')` (`src/agent/permissions.ts:43`). So once
    `bash(git status:*)` is saved, `git status && rm -rf ~` is auto-approved. Compound
    commands need splitting on `&&`, `;`, `|`, backticks, and `$()`, with every segment
    checked independently.
72. **[DONE]** **MCP tool descriptions flow unfiltered into the system prompt**
    (`src/agent/prompt.ts:32`) — a prompt-injection surface from any connected server.
73. **[DONE]** **`web_fetch` approval is per-origin-host only.** Redirects are followed and capped,
    but a redirect to a different host is not re-approved.
74. **[DONE]** **`/permissions` reads `agent['settings']`** via bracket-string access
    (`src/ui/App.tsx:287`) to dodge the type system, on a field that is already public.

---

## Suggested order

1. **[DONE]** **Items 26, 28, 29** — markdown rendering, diffs, collapsible output. Biggest
   perceived-quality jump per line of code, and 28 closes a real safety hole.
2. **[DONE]** **Item 71** — the bash rule hole, before anyone relies on saved rules.
3. **[DONE]** **Items 18, 19, 21, 22** — the risk classifier, shift+tab cycling, plan-mode exit,
   and unblocking MCP reads in plan mode. Together these are "plan / auto / normal".
4. **[DONE]** **Items 32, 37, 39** — queued input, prompt history, todo panel. The three that most
   change how the tool feels to drive.
5. **[DONE]** **Items 7, 9, 13** — MCP notifications, parallel connect with timeouts, tool budgeting.
6. **[DONE]** **Item 60** — hooks, once the tool loop is stable enough to hang callbacks on.


---

## Where the implementation departs from the card

**#29 — collapsible output.** `ctrl+o` cannot expand output already in
scrollback. Ink's `<Static>` writes each entry to the terminal once and never
re-renders it, which is what keeps a long session cheap. The transcript is split
into two regions instead: `items` (scrollback, immutable) and `live` (the
current turn, re-renderable). Tool results advertise "ctrl+o to expand" only
while live, because in scrollback the hint would be a lie.

**#56 — web search.** There is no scrapeable search endpoint: `html.duckduckgo.com`
and `lite.duckduckgo.com` both return a bot-check page rather than results, and
working around that is neither reliable nor worth building. `web_search` talks to
a real search API (Brave or Tavily) configured via `settings.search` or
`BRAVE_API_KEY`/`TAVILY_API_KEY`. With no key it reports that it is unconfigured —
in its tool description as well as its output — so the model asks for a URL
instead of retrying a tool that cannot work.

## Bugs found while implementing

1. `describe()` assumed `call.input` was always present, and threw on a tool call
   with no arguments — which several MCP tools legitimately are.
2. The persistent shell hung until timeout on any command that killed it
   (`exit`), because the completion sentinel never arrived. It now watches for
   the shell's own exit and reports its status.
3. The `<Static>` constraint above.
4. `test/ui.smoke.tsx`'s stub agent drifted from the real `Agent` twice, crashing
   the app when the footer began calling `cost.estimateUSD()` and `/status` began
   reading `agent.tools`. The fixture is a hand-written double; extend it when the
   UI reads something new.
5. One assertion in `test/session.test.ts` was written as `x === false || true` —
   tautologically passing. Replaced with a real byte-comparison of the appended
   line.
