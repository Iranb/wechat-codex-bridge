import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { lstat, readFile, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { NativeJournal } from './native-journal.mjs';
import { acquireLock, statePath, localSocketPath } from './runtime.mjs';
import { localCall } from './local-ipc.mjs';

const args = process.argv.slice(2), action = args[0];
if (!args.includes('--live') || !['start', 'stop', 'status'].includes(action)) throw new Error('Usage: node src/exec-runtime.mjs start|stop|status --live');
const journalPath = join(dirname(statePath()), 'codex-session.json');
const script = fileURLToPath(new URL('./exec.mjs', import.meta.url));
const project = dirname(dirname(script));
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
async function owner() {
  try {
    const info = await lstat(journalPath + '.lock');
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('unsafe_controller_lock');
    const text = (await readFile(journalPath + '.lock', 'utf8')).trim();
    if (!/^[1-9]\d*$/.test(text)) throw new Error('invalid_controller_lock');
    const pid = Number(text);
    if (!alive(pid)) return null;
    const { stdout } = await promisify(execFile)('/bin/ps', ['-p', String(pid), '-o', 'command=']);
    const command = stdout.trim();
    // Never signal a shared ChatGPT/Codex process or an unidentified PID.
    if (!command.includes(script)) throw new Error('unrecognized_controller_process');
    return { pid, transport: 'codex-exec' };
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

let release;
try {
  release = await acquireLock(journalPath + '.runtime');
  const current = await owner();
  if (action === 'status') {
    emit({ controller: current, ...(await new NativeJournal(journalPath).load()).status(),
      wechat: await localCall(localSocketPath(), { command: 'status' }) });
  } else if (action === 'stop') {
    if (current) {
      process.kill(current.pid, 'SIGTERM');
      const deadline = Date.now() + 10_000;
      while (alive(current.pid) && Date.now() < deadline) await pause(100);
      if (alive(current.pid)) throw new Error('controller_stop_unconfirmed');
    }
    emit({ status: 'stopped', controllerOnly: true });
  } else {
    if (current) {
      if (current.transport !== 'codex-exec') throw new Error('old_controller_must_stop_first');
      emit({ status: 'already_running', ...current });
    } else {
      const journal = await new NativeJournal(journalPath).load();
      if (journal.data.transport !== 'codex-exec' || journal.data.cliProbe?.stage !== 'completed') throw new Error('exec_prepare_required');
      const logPath = join(dirname(journalPath), 'exec-controller.log');
      const log = await open(logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
      try {
        const info = await log.stat();
        if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('private_controller_log_required');
        const child = spawn(process.execPath, [script, 'run', '--live'], { cwd: project, detached: true,
          stdio: ['ignore', log.fd, log.fd], shell: false });
        let failed = false;
        child.once('error', () => { failed = true; }); child.unref();
        const deadline = Date.now() + 20_000;
        for (;;) {
          if (failed || !alive(child.pid)) throw new Error('exec_controller_start_failed');
          const latest = await new NativeJournal(journalPath).load();
          const status = latest.status();
          const loaded = await owner();
          if (loaded?.pid === child.pid && latest.data.runtime?.pid === child.pid && !latest.data.runtime?.stoppedAt && ['waiting', 'processing'].includes(status.phase)) {
            emit({ status: 'started', pid: child.pid, ...status }); break;
          }
          if (Date.now() >= deadline) throw new Error('exec_controller_start_unconfirmed');
          await pause(200);
        }
      } finally { await log.close(); }
    }
  }
} catch (error) {
  emit({ status: 'error', reason: /^[a-z_]+$/.test(error.message) ? error.message : 'exec_runtime_requires_review' });
  process.exitCode = 1;
} finally { await release?.(); }
