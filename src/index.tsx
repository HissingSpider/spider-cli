import path from 'node:path';
import React from 'react';
import { render } from 'ink';
import { Agent } from './agent/loop.ts';
import { describe } from './agent/loop.ts';
import {
  addMcpServer,
  allModels,
  loadCredentials,
  loadProjectInstructions,
  loadSettings,
  loadSettingsFile,
  readClaudeDesktopServers,
  removeMcpServer,
  type PermissionMode,
} from './config.ts';
import os from 'node:os';
import * as sessions from './session.ts';
import { connectServers, isHttpConfig, type McpConnection, type McpStatus } from './mcp/client.ts';
import { createResourceTools } from './tools/mcp-resources.ts';
import { loginToServer } from './mcp/login.ts';
import { forgetServer, hasStoredTokens } from './mcp/oauth.ts';
import {
  describeServer,
  gateDirectory,
  gateUntrusted,
  isTrusted,
  isTrustedDir,
  trust,
  trustDir,
  untrust,
  untrustDir,
} from './mcp/trust.ts';
import { addWorkspaceRoot } from './agent/permissions.ts';
import { App } from './ui/App.tsx';
import { notice } from './ui/notices.ts';
import { runHooks } from './agent/hooks.ts';
import { elicit } from './ui/elicit.ts';

type Args = {
  prompt?: string;
  model?: string;
  mode?: PermissionMode;
  resume: boolean;
  resumeId?: string;
  continueLast: boolean;
  help: boolean;
  allowedTools: string[];
  disallowedTools: string[];
  addDirs: string[];
  settingsFile?: string;
  appendSystemPrompt?: string;
  maxTurns?: number;
  outputFormat: 'text' | 'json' | 'stream-json';
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    resume: false,
    continueLast: false,
    help: false,
    allowedTools: [],
    disallowedTools: [],
    addDirs: [],
    outputFormat: 'text',
  };
  const list = (v: string | undefined) =>
    (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-p' || a === '--print') args.prompt = argv[++i];
    else if (a === '--model' || a === '-m') args.model = argv[++i];
    else if (a === '--mode' || a === '--permission-mode') args.mode = argv[++i] as PermissionMode;
    else if (a === '--resume' || a === '-r') {
      args.resume = true;
      // `--resume <id>` takes an argument; bare `--resume` means most recent.
      if (argv[i + 1] && !argv[i + 1].startsWith('-')) args.resumeId = argv[++i];
    } else if (a === '--continue' || a === '-c') {
      args.continueLast = true;
      args.resume = true;
    } else if (a === '--allowed-tools' || a === '--allowedTools') {
      args.allowedTools.push(...list(argv[++i]));
    } else if (a === '--disallowed-tools' || a === '--disallowedTools') {
      args.disallowedTools.push(...list(argv[++i]));
    } else if (a === '--add-dir') args.addDirs.push(argv[++i]);
    else if (a === '--settings') args.settingsFile = argv[++i];
    else if (a === '--append-system-prompt') args.appendSystemPrompt = argv[++i];
    else if (a === '--max-turns') args.maxTurns = Number(argv[++i]);
    else if (a === '--output-format') args.outputFormat = argv[++i] as Args['outputFormat'];
    else if (a === '--help' || a === '-h') args.help = true;
    else if (!a.startsWith('-') && !args.prompt) args.prompt = a;
  }
  return args;
}

const USAGE = `spider — an agentic coding CLI on the SpiderAI API

Usage:
  spider                       Start an interactive session
  spider -p "<prompt>"         Run one prompt headlessly and print the result
  spider --model gpt-5         Choose a model (${allModels().join(', ')})
  spider --mode plan           Permission mode: default, acceptEdits, auto, plan, bypassPermissions
  spider --resume              Continue the most recent session in this directory
  spider trust [dir]           Trust a directory, so its config is honoured
  spider untrust [dir]         Stop trusting a directory
  spider mcp list              Show configured MCP servers, auth and trust status
  spider mcp add <name> <cmd>  Add a local server to .mcp.json
  spider mcp add <name> --url  Add a remote server to .mcp.json
  spider mcp remove <server>   Remove a server from .mcp.json
  spider mcp import            Import servers from a Claude Desktop config
  spider mcp trust <server>    Approve a server without the interactive prompt
  spider mcp login <server>    Authorize a remote MCP server via OAuth
  spider mcp logout <server>   Forget stored credentials for a server

Options:
  --allowed-tools a,b          Pre-approve these tools (rule syntax)
  --disallowed-tools a,b       Deny these tools outright
  --add-dir <path>             Treat another directory as in-workspace
  --settings <file>            Load settings from a specific file
  --append-system-prompt <s>   Append text to the system prompt
  --max-turns <n>              Cap the tool-use rounds in one turn
  --output-format <fmt>        text (default), json, or stream-json — with -p
  --continue                   Resume the most recent session here
  --resume [id]                Resume a session by id, or the most recent

Configuration:
  SPIDERAI_API_KEY   from the SpiderAI My Account page
  SPIDERAI_BASE_URL  defaults to https://spideraiapi.richmond.edu/v1
  SPIDER.md          project instructions injected into the system prompt
  .spider/settings.json   model, permissionMode, allow and deny rules
  .spider/settings.local.json  personal rules, git-ignored
  .mcp.json               MCP servers, checked in with the project

Educational use only, per the SpiderAI terms.`;

/** `spider mcp <login|list|logout> [name]` */
async function mcpCommand(argv: string[], cwd: string): Promise<void> {
  const [sub, name] = argv;
  const settings = loadSettings(cwd);
  const servers = settings.mcpServers ?? {};

  if (sub === 'list' || !sub) {
    const names = Object.keys(servers);
    if (!names.length) {
      console.log('No MCP servers configured in .spider/settings.json');
      return;
    }
    for (const n of names) {
      const cfg = servers[n];
      const kind = isHttpConfig(cfg) ? cfg.url : cfg.command;
      const auth = isHttpConfig(cfg) ? (hasStoredTokens(n) ? '  [authorized]' : '  [no token]') : '';
      const off = cfg.enabled === false ? '  [disabled]' : '';
      const trusted = isTrusted(n, cfg) ? '' : '  [not trusted]';
      console.log('  ' + n.padEnd(20) + kind + auth + off + trusted);
    }
    return;
  }

  if (sub === 'logout') {
    if (!name) return void console.error('Usage: spider mcp logout <server>');
    console.log(forgetServer(name) ? 'Removed stored credentials for ' + name : 'Nothing stored for ' + name);
    return;
  }

  if (sub === 'add') {
    const [, , ...rest] = argv;
    if (!name || !rest.length) {
      console.error('Usage: spider mcp add <name> <command> [args...]');
      console.error('       spider mcp add <name> --url <https://...> [--scope "a b"]');
      return;
    }
    let cfg: Record<string, unknown>;
    if (rest[0] === '--url') {
      const url = rest[1];
      if (!url) return void console.error('--url needs a value');
      const scopeAt = rest.indexOf('--scope');
      cfg = { url, ...(scopeAt !== -1 && rest[scopeAt + 1] ? { scope: rest[scopeAt + 1] } : {}) };
    } else {
      cfg = { command: rest[0], ...(rest.length > 1 ? { args: rest.slice(1) } : {}) };
    }
    const file = addMcpServer(cwd, name, cfg);
    trust(name, cfg as any);
    console.log('Added "' + name + '" to ' + file + ' and trusted it.');
    return;
  }

  if (sub === 'remove' || sub === 'rm') {
    if (!name) return void console.error('Usage: spider mcp remove <server>');
    const gone = removeMcpServer(cwd, name);
    untrust(name);
    console.log(gone ? 'Removed "' + name + '" from .mcp.json' : 'No "' + name + '" in .mcp.json');
    return;
  }

  if (sub === 'import') {
    const found = readClaudeDesktopServers();
    const names = Object.keys(found);
    if (!names.length) {
      console.log('No Claude Desktop config with MCP servers found.');
      return;
    }
    for (const n of names) addMcpServer(cwd, n, found[n]);
    console.log(
      'Imported ' + names.length + ' server' + (names.length === 1 ? '' : 's') +
        ' into .mcp.json: ' + names.join(', ') + '\n' +
        'They are not trusted yet — you will be asked on the next run.',
    );
    return;
  }

  if (sub === 'trust') {
    if (!name) return void console.error('Usage: spider mcp trust <server>');
    const cfg = servers[name];
    if (!cfg) return void console.error('No MCP server named "' + name + '"');
    console.log(describeServer(name, cfg));
    trust(name, cfg);
    console.log('Trusted "' + name + '".');
    return;
  }

  if (sub === 'untrust') {
    if (!name) return void console.error('Usage: spider mcp untrust <server>');
    console.log(untrust(name) ? 'Untrusted "' + name + '".' : 'Nothing trusted for ' + name);
    return;
  }

  if (sub === 'login') {
    if (!name) return void console.error('Usage: spider mcp login <server>');
    const cfg = servers[name];
    if (!cfg) return void console.error('No MCP server named "' + name + '" in .spider/settings.json');
    if (!isHttpConfig(cfg)) return void console.error('"' + name + '" is a stdio server; it does not use OAuth.');

    const result = await loginToServer(name, cfg);
    if (result.ok) {
      console.log('\nAuthorized "' + name + '" — ' + result.toolCount + ' tools available.');
    } else {
      console.error('\nLogin failed: ' + result.error);
      process.exitCode = 1;
    }
    return;
  }

  console.error(
    'Usage: spider mcp <list|add|remove|import|trust|untrust|login|logout> [server] [...]',
  );
}

/** A boxed header, so a session starts by telling you where you are and under
 *  what authority rather than dropping you straight at a bare prompt. */
function printBanner(
  model: string,
  mode: string,
  cwd: string,
  connected: McpStatus[],
  resumed: boolean,
): void {
  const home = os.homedir();
  const shortCwd = cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
  const rows = [
    ['model', model],
    ['mode', mode],
    ['cwd', shortCwd],
  ];
  if (connected.length) {
    rows.push(['mcp', connected.map((s) => s.name + ' (' + s.toolCount + ')').join(', ')]);
  }
  if (resumed) rows.push(['session', 'resumed']);
  if (!isTrustedDir(cwd)) rows.push(['trust', 'UNTRUSTED — project config ignored']);

  const title = ' spider ';
  const body = rows.map(([k, v]) => '  ' + k.padEnd(8) + v);
  const width = Math.max(title.length + 4, ...body.map((l) => l.length + 2), 44);

  console.log('╭' + title + '─'.repeat(width - title.length - 1) + '╮');
  for (const line of body) console.log('│' + line.padEnd(width) + '│');
  console.log('╰' + '─'.repeat(width) + '╯');
  console.log(
    '  /help for commands · shift+tab cycles permission mode · ctrl+o expands output\n',
  );
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv[0] === 'trust' || argv[0] === 'untrust') {
    const dir = argv[1] ? path.resolve(argv[1]) : process.cwd();
    if (argv[0] === 'trust') {
      trustDir(dir);
      console.log('Trusted ' + dir);
    } else {
      console.log(untrustDir(dir) ? 'Untrusted ' + dir : dir + ' was not trusted.');
    }
    return;
  }

  if (argv[0] === 'mcp') {
    await mcpCommand(argv.slice(1), process.cwd());
    return;
  }
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const cwd = process.cwd();
  let creds;
  try {
    creds = loadCredentials(cwd);
  } catch (err: any) {
    console.error(err.message);
    process.exit(1);
  }

  // $HOME as the workspace means every search crawls Library, app bundles and
  // credential stores. Warn loudly rather than silently indexing all of it.
  const atHome = path.resolve(cwd) === path.resolve(os.homedir());
  if (atHome) {
    console.error(
      'Warning: running in your home directory, so the whole of ' + cwd + ' is the workspace.\n' +
        'Searches will be slow and wide. cd into a project directory instead.\n',
    );
  }

  // A project's own files can direct the agent, so an unfamiliar directory is
  // asked about before any of them are read.
  const { trusted } = await gateDirectory(cwd);

  const settings = trusted ? loadSettings(cwd) : loadSettings(os.tmpdir());
  if (!trusted) {
    console.error(
      'Running untrusted: this project\'s SPIDER.md, MCP servers and rules are ignored.\n' +
        'Run `spider trust` here to change that.\n',
    );
  }
  if (args.settingsFile) Object.assign(settings, loadSettingsFile(args.settingsFile));
  if (args.model) settings.model = args.model;
  if (args.mode) settings.permissionMode = args.mode;
  if (args.maxTurns) settings.maxTurns = args.maxTurns;
  settings.allow.push(...args.allowedTools);
  settings.deny.push(...args.disallowedTools);
  for (const dir of args.addDirs) addWorkspaceRoot(dir);

  // MCP servers are connected before the agent is built so their tools are
  // part of the toolset from the first turn. Connection is concurrent and each
  // server has its own deadline, so one slow server delays nobody; a server
  // that fails is reported and skipped.
  let agent: Agent;
  let mcp: McpConnection;

  const notices: string[] = [];
  let mounted = false;
  // Nothing connects before the user has said yes to it once.
  const { approved } = await gateUntrusted(settings.mcpServers);

  mcp = await connectServers(approved, cwd, {
    onNotice: (t) => {
      // Before the TUI exists these are buffered; App drains them on mount.
      if (mounted) notice(t);
      else notices.push(t);
    },
    // A server can add or drop tools at any time; rebuild the agent's map.
    onToolsChanged: (tools) => {
      agent?.setExtraTools({ ...tools, ...createResourceTools(mcp) });
    },
    // Sampling: a server asks us to run an inference. It spends the user's
    // tokens, so it is announced and billed to the same tracker rather than
    // happening invisibly.
    onSampling: async (req) => {
      if (!agent) throw new Error('not ready');
      const prompt = req.messages.map((m) => m.role + ': ' + m.text).join('\n');
      return agent.complete(
        prompt,
        req.systemPrompt ??
          'You are answering a request from the "' + req.server + '" MCP server. Be brief.',
        req.maxTokens ?? 1024,
      );
    },
    onElicit: (req) => elicit(req),
  });

  const mcpStatus: McpStatus[] = mcp.status;
  for (const s of mcpStatus) {
    if (!s.ok && s.state !== 'disabled') {
      console.error('MCP server "' + s.name + '" failed: ' + s.error);
    }
  }
  process.on('exit', () => void mcp.close());

  agent = new Agent(
    cwd,
    settings,
    trusted ? loadProjectInstructions(cwd) : null,
    creds.baseUrl,
    creds.apiKey,
    { extraTools: { ...mcp.tools, ...createResourceTools(mcp) } },
  );

  if (args.appendSystemPrompt) agent.extraSystemPrompt = args.appendSystemPrompt;

  // SessionStart hooks run once the agent exists but before any turn.
  {
    const start = await runHooks('SessionStart', settings, {}, cwd);
    for (const n of start.notices) console.error(n);
    if (start.context) agent.turns.push({ role: 'user', text: '[hook context]\n' + start.context });
  }

  let sessionId = sessions.newSessionId();
  let resumedTurns = 0;
  if (args.resume) {
    const prev = args.resumeId ? sessions.byId(args.resumeId, cwd) : sessions.mostRecent(cwd);
    if (args.resumeId && !prev) {
      console.error('No session "' + args.resumeId + '" for this directory.');
      const available = sessions.list(cwd).slice(0, 10);
      if (available.length) {
        console.error('Recent sessions here:');
        for (const s2 of available) {
          console.error('  ' + s2.id + '  ' + (s2.title ?? '(untitled)'));
        }
      }
      process.exit(1);
    }
    if (prev) {
      agent.turns = prev.turns;
      sessionId = prev.id;
      resumedTurns = prev.turns.length;
      // Resuming restores the authority the session was running under, not just
      // its transcript — an explicit --mode on this invocation still wins.
      if (prev.mode && !args.mode) agent.mode = prev.mode;
      for (const rule of prev.allow ?? []) {
        if (!settings.allow.includes(rule)) settings.allow.push(rule);
      }
    }
  }

  // Headless: one prompt, no TTY required.
  if (args.prompt) {
    const json = args.outputFormat === 'json';
    const streamJson = args.outputFormat === 'stream-json';
    const emit = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + '\n');

    let assistantText = '';
    const toolLog: Array<{ tool: string; ok: boolean }> = [];
    let refusals = 0;

    if (streamJson) emit({ type: 'session', session_id: sessionId, model: agent.model, cwd });

    try {
      await agent.run(args.prompt, {
        onDelta: (d) => {
          assistantText += d;
          if (streamJson) emit({ type: 'delta', text: d });
          else if (!json) process.stdout.write(d);
        },
        onAssistantEnd: () => {
          if (!json && !streamJson) process.stdout.write('\n');
        },
        onToolStart: (call) => {
          if (streamJson) emit({ type: 'tool_use', name: call.name, input: call.input });
          else if (!json) process.stderr.write('● ' + describe(call) + '\n');
        },
        onToolEnd: (call, output, isError) => {
          toolLog.push({ tool: call.name, ok: !isError });
          if (streamJson) emit({ type: 'tool_result', name: call.name, output, is_error: isError });
          else if (!json && isError) process.stderr.write('  ✗ ' + output.split('\n')[0] + '\n');
        },
        onNotice: (t) => {
          if (streamJson) emit({ type: 'notice', text: t });
          else if (!json) process.stderr.write(t + '\n');
        },
        // Nobody is here to answer, so an approval is a refusal. --allowed-tools
        // and --mode are how a scripted run grants authority up front.
        requestPermission: async (call) => {
          refusals++;
          const msg =
            'needs approval, refused in headless mode: ' + describe(call) +
            ' — pre-approve it with --allowed-tools, or use --mode acceptEdits / auto.';
          if (streamJson) emit({ type: 'permission_denied', name: call.name, message: msg });
          else if (!json) process.stderr.write('✗ ' + msg + '\n');
          return 'deny';
        },
      });
      sessions.save({
        id: sessionId,
        cwd,
        model: agent.model,
        updatedAt: '',
        turns: agent.turns,
        mode: agent.mode,
        allow: settings.allow,
      });

      if (json) {
        emit({
          type: 'result',
          session_id: sessionId,
          model: agent.model,
          result: assistantText.trim(),
          tools: toolLog,
          permission_refusals: refusals,
          usage: { input: agent.cost.input, output: agent.cost.output },
          cost_usd: agent.cost.estimateUSD(),
        });
      } else if (streamJson) {
        emit({
          type: 'done',
          session_id: sessionId,
          permission_refusals: refusals,
          usage: { input: agent.cost.input, output: agent.cost.output },
        });
      } else {
        process.stderr.write('\n' + agent.cost.summary() + '\n');
      }

      await mcp.close();
      // A refused approval means the task did not actually complete; a script
      // needs to be able to tell that from success.
      if (refusals > 0) process.exitCode = 2;
    } catch (err: any) {
      const message = err?.message ?? String(err);
      if (json || streamJson) emit({ type: 'error', error: message });
      else console.error('\nError: ' + message);
      await mcp.close();
      process.exit(1);
    }
    return;
  }

  const connected = mcpStatus.filter((s) => s.ok);
  printBanner(agent.model, agent.mode, cwd, connected, !!args.resume && resumedTurns > 0);
  mounted = true;
  render(
    <App
      agent={agent}
      cwd={cwd}
      sessionId={sessionId}
      initialTurns={resumedTurns}
      mcpStatus={mcpStatus}
      mcp={mcp}
      pendingNotices={notices}
    />,
    // Ink exits the process on ctrl+c by default, which would preempt the
    // interrupt-then-confirm handling in App.
    { exitOnCtrlC: false },
  );
}

main();
