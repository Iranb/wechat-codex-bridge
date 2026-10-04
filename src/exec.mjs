import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeClient } from './native-client.mjs';
import { NativeJournal } from './native-journal.mjs';
import { ExecController } from './exec-controller.mjs';
import { acquireLock, statePath, localSocketPath } from './runtime.mjs';
import { localCall } from './local-ipc.mjs';

const args = process.argv.slice(2);
const action = args[0];
if (!args.includes('--live') || !['prepare', 'run', 'status'].includes(action)) throw new Error('Usage: node src/exec.mjs prepare|run|status --live');
const path = join(dirname(statePath()), 'codex-session.json');
const emit = value => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`);
if (action === 'status') {
  emit((await new NativeJournal(path).load()).status());
} else {
  // Same lock/journal as the old controller: the two transports cannot run
  // concurrently, create a replacement session, or forget a prior send.
  const release = await acquireLock(path);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  let client, journal;
  try {
    journal = await new NativeJournal(path).load();
    client = await NativeClient.openDaemon();
    const controller = new ExecController({ client, journal, socketPath: localSocketPath(), statePath: statePath(),
      cwd: fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, ''), emit });
    await controller.prepare();
    emit({ event: 'exec_thread_checked', ...journal.status() });
    emit({ event: 'exec_context_test', ...await controller.probe(abort.signal, { newProbe: action === 'prepare' && args.includes('--new-probe') }) });
    await journal.update(data => {
      if (!data.active && ['native_queue_submission_unconfirmed', 'native_thread_active_writer', 'native_rpc_rejected', 'native_disconnected', 'exec_completion_unconfirmed', 'exec_context_probe_failed'].includes(data.pauseReason)) {
        data.phase = 'prepared'; delete data.pauseReason;
      }
    });
    if (action === 'run') {
      const status = await localCall(localSocketPath(), { command: 'status' });
      if (status.mode !== 'local-queue' || !status.ownerBound || !status.accountConfigured || !status.normalReceptionActivated) throw new Error('wechat_queue_not_ready');
      if (journal.data.activationAt && journal.data.activationAt !== status.activationAt) throw new Error('activation_watermark_changed');
      await journal.update(data => {
        data.activationAt = status.activationAt;
        data.runtime = { pid: process.pid, startedAt: new Date().toISOString() };
        if (!data.active && data.phase === 'prepared') data.phase = 'waiting';
      });
      emit({ event: 'exec_route_listening', ...journal.status() });
      await controller.run(abort.signal);
    }
  } catch (error) {
    const reason = /^[a-z_]+$/.test(error.message) ? error.message : 'exec_route_requires_review';
    if (journal) await journal.update(data => { data.phase = 'paused'; data.pauseReason = reason; }).catch(() => {});
    emit({ event: 'exec_route_stopped', reason, ...(journal ? journal.status() : {}) });
    process.exitCode = 1;
  } finally {
    client?.close(); await release();
    if (journal?.data.runtime?.pid === process.pid) await journal.update(data => { data.runtime.stoppedAt = new Date().toISOString(); }).catch(() => {});
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
  }
}
