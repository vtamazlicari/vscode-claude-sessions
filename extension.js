const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { StringDecoder } = require('string_decoder');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const CURRENT_LOG = 'Claude VSCode.log';
const PREVIOUS_LOG = 'Claude VSCode.1.log';

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

  getParent() {
    return undefined;
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

class ShownSessionTracker {
  constructor(logDir) {
    this.logDir = logDir;
    this.readAll();
  }

  readAll() {
    this.launches = new Map();
    this.shownChannel = undefined;
    this.offset = 0;
    this.decoder = new StringDecoder('utf8');
    this.rest = '';
    const previous = path.join(this.logDir, PREVIOUS_LOG);
    if (fs.existsSync(previous)) this.feed(`${fs.readFileSync(previous, 'utf8')}\n`);
    this.readNew();
  }

  readNew() {
    const file = path.join(this.logDir, CURRENT_LOG);
    if (!fs.existsSync(file)) return;
    const size = fs.statSync(file).size;
    if (size < this.offset) return this.readAll();
    if (size === this.offset) return;
    const buffer = Buffer.alloc(size - this.offset);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buffer, 0, buffer.length, this.offset);
    } finally {
      fs.closeSync(fd);
    }
    this.offset = size;
    this.feed(this.decoder.write(buffer));
  }

  feed(text) {
    const lines = (this.rest + text).split('\n');
    this.rest = lines.pop();
    for (const line of lines) {
      const launch = line.match(/^(\S+ \S+) \[info\] Launching Claude on channel: (\S+)/);
      if (launch) {
        this.launches.set(launch[2], new Date(launch[1].replace(' ', 'T')).getTime());
        continue;
      }
      const ui = line.match(/"channelId":"([^"]+)".*"request":\{"type":"engine_ui_(attach|detach)"/);
      if (ui && ui[2] === 'attach') this.shownChannel = ui[1];
      if (ui && ui[2] === 'detach' && this.shownChannel === ui[1]) this.shownChannel = undefined;
    }
  }

  findShownSessionId(sessions) {
    const launchedAt = this.launches.get(this.shownChannel);
    if (launchedAt === undefined) return undefined;
    const toProcessStart = (s) => (s.procStart ? Date.parse(`${s.procStart} UTC`) : s.startedAt);
    return sessions
      .map((s) => ({ sessionId: s.sessionId, gap: Math.abs(toProcessStart(s) - launchedAt) }))
      .filter((match) => match.gap < 3000)
      .sort((a, b) => a.gap - b.gap)[0]?.sessionId;
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// Claude creates its log folder after this extension may activate, so wait for a missing folder instead of throwing.
function watchDebounced(dir, onChange, filename) {
  let timer;
  let watcher;
  const start = () => {
    if (!fs.existsSync(dir)) return;
    clearInterval(poll);
    watcher = fs.watch(dir, (_event, changed) => {
      if (filename && changed !== filename) return;
      clearTimeout(timer);
      timer = setTimeout(onChange, 300);
    });
  };
  const poll = setInterval(start, 1000);
  start();
  return {
    dispose: () => {
      clearInterval(poll);
      clearTimeout(timer);
      watcher?.close();
    },
  };
}

function activate(context) {
  const provider = new SessionsProvider();
  const treeView = vscode.window.createTreeView('claudeSessions.list', { treeDataProvider: provider });
  const claudeLogDir = path.join(path.dirname(context.logUri.fsPath), 'Anthropic.claude-code');
  const tracker = new ShownSessionTracker(claudeLogDir);
  let highlightedSessionId;

  const highlightShown = () => {
    if (!treeView.visible) return;
    tracker.readNew();
    const sessions = readRunningSessions();
    const shown = sessions.find((s) => s.sessionId === tracker.findShownSessionId(sessions));
    if (!shown || shown.sessionId === highlightedSessionId) return;
    highlightedSessionId = shown.sessionId;
    treeView.reveal(shown, { select: true, focus: false }).then(undefined, () => {});
  };

  const reselectWhenCleared = ({ selection }) => {
    if (selection.length > 0 || !highlightedSessionId) return;
    const shown = provider.sessions.find((s) => s.sessionId === highlightedSessionId);
    if (shown) treeView.reveal(shown, { select: true, focus: false }).then(undefined, () => {});
  };

  const refreshAndHighlight = () => {
    highlightedSessionId = undefined;
    provider.refresh();
    highlightShown();
  };

  context.subscriptions.push(
    treeView,
    watchDebounced(SESSIONS_DIR, refreshAndHighlight),
    watchDebounced(claudeLogDir, highlightShown, CURRENT_LOG),
    treeView.onDidChangeVisibility(refreshAndHighlight),
    treeView.onDidChangeSelection(reselectWhenCleared),
    vscode.commands.registerCommand('claudeSessions.open', (session) => showInSidebar(session.sessionId)),
    vscode.commands.registerCommand('claudeSessions.new', () => vscode.commands.executeCommand('claude-vscode.newConversation')),
    vscode.commands.registerCommand('claudeSessions.close', async (session) => {
      tracker.readNew();
      const shownSessionId = tracker.findShownSessionId(provider.sessions);
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
  highlightShown();
}

module.exports = { activate };
