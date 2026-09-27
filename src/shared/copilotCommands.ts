/**
 * Command reference for the GitHub Copilot CLI.
 *
 * Same shape as claudeCommands.ts / codexCommands.ts so the Command Center and
 * the generated hive command guide can render provider-native commands.
 *
 * Evidence: every `slash` entry below appears in the interactive command table of
 * the installed CLI (GitHub Copilot CLI 1.0.88), printed by `copilot help commands`
 * — the same table `/help` shows inside the TUI. Every `cli` entry appears in
 * `copilot --help` on that version. Nothing here comes from docs alone; re-check
 * against `copilot help commands` before adding to this list.
 *
 * `kind` semantics match claudeCommands.ts:
 *   - `slash`  — typed inside the Copilot interactive session
 *   - `cli`    — shell flags / sub-commands passed at launch
 */
import type { CmdGroup } from './claudeCommands';

export const COPILOT_COMMAND_GROUPS: CmdGroup[] = [
  {
    title: 'SESSION',
    items: [
      // providerAutomation sends these two for auto-compact / context reset.
      { cmd: '/compact', kind: 'slash', desc: 'Summarize conversation history to reduce context window usage. Takes optional focus instructions.', usage: '/compact keep the current task and next step' },
      { cmd: '/clear', kind: 'slash', desc: 'Abandon this session and start fresh. The CLI keeps running.' },
      { cmd: '/new', kind: 'slash', desc: 'Start a new conversation.' },
      { cmd: '/resume', kind: 'slash', desc: 'Switch to a different session (optionally by session ID, task ID, or name).' },
      { cmd: '/rename', kind: 'slash', desc: 'Rename the current session, or auto-generate a name from the conversation.' },
      { cmd: '/fork', kind: 'slash', desc: 'Fork the current session into a new session, optionally with a name.' },
      { cmd: '/context', kind: 'slash', desc: 'Show context window token usage and a visualization.' },
      { cmd: '/usage', kind: 'slash', desc: 'Display session usage metrics and statistics.' },
      { cmd: '/session', kind: 'slash', desc: 'View and manage sessions.' },
      { cmd: '/rewind', kind: 'slash', desc: 'Rewind the last turn and revert its file changes.' },
      { cmd: '/copy', kind: 'slash', desc: 'Copy the last response to the clipboard.' },
      { cmd: '/share', kind: 'slash', desc: 'Share the session to a markdown file, HTML file, gist, or GitHub link.' },
      { cmd: '/exit', kind: 'slash', desc: 'Exit the CLI.' },
      { cmd: 'copilot --resume <session-id>', kind: 'cli', desc: 'Resume a previous session by ID, task ID, ID prefix, or name. Munder Difflin uses this to restart an agent into its last session.' },
      { cmd: 'copilot --continue', kind: 'cli', desc: 'Resume the most recent session.' }
    ]
  },
  {
    title: 'MODELS & AGENTS',
    items: [
      { cmd: '/model', kind: 'slash', desc: "Select the AI model for this session ('auto' lets Copilot pick)." },
      { cmd: '/agent', kind: 'slash', desc: 'Browse and select agents.', usage: '/agent [name]' },
      { cmd: '/subagents', kind: 'slash', desc: 'Configure default and per-agent subagent models.' },
      { cmd: '/tasks', kind: 'slash', desc: 'View and manage tasks (subagents and shell commands).' },
      { cmd: '/fleet', kind: 'slash', desc: 'Enable fleet mode for parallel subagent execution.' },
      { cmd: '/plan', kind: 'slash', desc: 'Create an implementation plan before coding.' },
      { cmd: '/ask', kind: 'slash', desc: 'Ask a quick side question without adding it to the conversation history.' },
      { cmd: 'copilot --model <model>', kind: 'cli', desc: "Set the model at launch ('auto' lets Copilot pick).", usage: 'copilot --model claude-sonnet-4.5' }
    ]
  },
  {
    title: 'PERMISSIONS',
    items: [
      { cmd: '/permissions', kind: 'slash', desc: 'Switch between permission modes.' },
      { cmd: '/allow-all', kind: 'slash', desc: 'Enable all permissions (tools, paths, and URLs).' },
      { cmd: '/add-dir', kind: 'slash', desc: 'Allow file access to another directory.' },
      { cmd: '/list-dirs', kind: 'slash', desc: 'Display allowed directories and exact session path grants.' },
      { cmd: '/reset-allowed-tools', kind: 'slash', desc: 'Reset session tool and exact-path approvals.' },
      { cmd: 'copilot --allow-all-tools --no-ask-user', kind: 'cli', desc: 'Never stop for a tool-permission prompt or an ask_user question. What Munder Difflin uses for auto mode.' }
    ]
  },
  {
    title: 'CODE',
    items: [
      { cmd: '/diff', kind: 'slash', desc: 'Review the changes made in the current directory.' },
      { cmd: '/review', kind: 'slash', desc: 'Run the code review agent over your changes.' },
      { cmd: '/security-review', kind: 'slash', desc: 'Analyze staged and unstaged changes for security vulnerabilities.' },
      { cmd: '/pr', kind: 'slash', desc: 'Operate on pull requests for the current branch.' }
    ]
  },
  {
    title: 'ENVIRONMENT & LIMITS',
    items: [
      { cmd: '/env', kind: 'slash', desc: 'Show loaded instructions, MCP servers, skills, agents, hooks, and plugins.' },
      { cmd: '/instructions', kind: 'slash', desc: 'View and toggle custom instruction files.' },
      { cmd: '/mcp', kind: 'slash', desc: 'Manage MCP server configuration.' },
      { cmd: '/skills', kind: 'slash', desc: 'Manage skills.' },
      { cmd: '/limits', kind: 'slash', desc: 'View or edit session limits. The AI Credit limit is a soft cap.' },
      { cmd: '/help', kind: 'slash', desc: 'Show help for interactive commands.' },
      { cmd: 'copilot -i "<prompt>"', kind: 'cli', desc: 'Start interactive mode and run this prompt first. How Munder Difflin seeds the hive protocol.' },
      { cmd: 'copilot -p "<prompt>"', kind: 'cli', desc: 'Non-interactive mode: run one prompt and exit.' }
    ]
  }
];
