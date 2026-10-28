const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');

function isOwnLiveProcess(pid) {
  try {
    return execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)]).toString().trim() === String(process.pid);
  } catch {
    return false;
  }
}

function readRunningSessions() {
  return fs
    .readdirSync(SESSIONS_DIR)
    .filter((file) => /^\d+\.json$/.test(file))
    .map((file) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
      } catch {
        return undefined;
      }
    })
    .filter((s) => s && s.entrypoint === 'claude-vscode' && isOwnLiveProcess(s.pid))
    .sort((a, b) => a.startedAt - b.startedAt);
}

function toTranscriptPath(session) {
  return path.join(CLAUDE_DIR, 'projects', session.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${session.sessionId}.jsonl`);
}

const hasMessages = (session) => fs.existsSync(toTranscriptPath(session));

function findTitle(session) {
  const transcript = toTranscriptPath(session);
  if (!fs.existsSync(transcript)) return 'New chat';
  let title = session.name;
  for (const line of fs.readFileSync(transcript, 'utf8').split('\n')) {
    if (!line.includes('itle"')) continue;
    try {
      const entry = JSON.parse(line);
      title = entry.customTitle ?? entry.aiTitle ?? title;
    } catch {}
  }
  return title;
}

class SessionsProvider {
  changed = new vscode.EventEmitter();
  onDidChangeTreeData = this.changed.event;
  sessions = [];

  refresh() {
    this.changed.fire();
  }

  getChildren() {
    this.sessions = readRunningSessions();
    return this.sessions;
  }

  getTreeItem(session) {
    const title = findTitle(session);
    const item = new vscode.TreeItem(title);
    item.id = session.sessionId;
    item.contextValue = this.sessions.length === 1 && title === 'New chat' ? 'lastEmptySession' : 'session';
    item.description = session.status === 'busy' ? 'working' : '';
    item.iconPath = new vscode.ThemeIcon(session.status === 'busy' ? 'loading~spin' : 'comment');
    item.tooltip = `Started ${new Date(session.startedAt).toLocaleTimeString()}`;
    item.command = { command: 'claudeSessions.open', title: 'Show', arguments: [session] };
    return item;
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findShownSessionId(logDir, sessions) {
  const text = ['Claude VSCode.1.log', 'Claude VSCode.log']
    .map((file) => path.join(logDir, file))
    .filter((file) => fs.existsSync(file))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  const launches = new Map();
  let lastLaunched;
  let shownChannel;
  for (const line of text.split('\n')) {
    const launch = line.match(/^(\S+ \S+) \[info\] Launching Claude on channel: (\S+)/);
    if (launch) {
      lastLaunched = { at: new Date(launch[1].replace(' ', 'T')).getTime() };
      launches.set(launch[2], lastLaunched);
      continue;
    }
    const resume = line.match(/\[info\] Spawning Claude .*resume: (\S+)/);
    if (resume && lastLaunched) lastLaunched.resume = resume[1];
    const ui = line.match(/"channelId":"([^"]+)".*"request":\{"type":"engine_ui_(attach|detach)"/);
    if (ui && ui[2] === 'attach') shownChannel = ui[1];
    if (ui && ui[2] === 'detach' && shownChannel === ui[1]) shownChannel = undefined;
  }
  const launch = launches.get(shownChannel);
  if (!launch) return undefined;
  if (launch.resume) return sessions.find((s) => s.sessionId.startsWith(launch.resume))?.sessionId;
  return sessions.find((s) => s.startedAt >= launch.at && s.startedAt - launch.at < 5000)?.sessionId;
}

function findNeighbour(sessions, closing) {
  const index = sessions.findIndex((s) => s.sessionId === closing.sessionId);
  const before = sessions.slice(0, index).filter(hasMessages).pop();
  return before ?? sessions.slice(index + 1).find(hasMessages);
}

function showInSidebar(sessionId) {
  return vscode.commands.executeCommand('claude-vscode.editor.open', sessionId, undefined, undefined, undefined, undefined, {
    programmatic: 'honor-preferred-location',
  });
}

function activate(context) {
  const provider = new SessionsProvider();
  const claudeLogDir = path.join(path.dirname(context.logUri.fsPath), 'Anthropic.claude-code');

  let debounce;
  const watcher = fs.watch(SESSIONS_DIR, () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => provider.refresh(), 300);
  });

  context.subscriptions.push(
    { dispose: () => watcher.close() },
    vscode.window.registerTreeDataProvider('claudeSessions.list', provider),
    vscode.commands.registerCommand('claudeSessions.open', (session) => showInSidebar(session.sessionId)),
    vscode.commands.registerCommand('claudeSessions.new', () => vscode.commands.executeCommand('claude-vscode.newConversation')),
    vscode.commands.registerCommand('claudeSessions.close', async (session) => {
      const shownSessionId = findShownSessionId(claudeLogDir, provider.sessions);
      if (shownSessionId === undefined || shownSessionId === session.sessionId) {
        const neighbour = findNeighbour(provider.sessions, session);
        if (neighbour) await showInSidebar(neighbour.sessionId);
        else await vscode.commands.executeCommand('claude-vscode.newConversation');
        await delay(1000);
      }
      try {
        process.kill(session.pid, 'SIGTERM');
      } catch {}
    }),
  );
}

module.exports = { activate };
