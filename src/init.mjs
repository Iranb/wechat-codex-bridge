import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeClient } from './native-client.mjs';
import { NativeJournal } from './native-journal.mjs';
import { NativeController } from './native-controller.mjs';
import { acquireLock, statePath } from './runtime.mjs';

if (!process.argv.includes('--live')) throw new Error('Explicit --live required');
const path = join(dirname(statePath()), 'codex-session.json');
const release = await acquireLock(path);
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
let client, journal;
try {
  journal = await new NativeJournal(path).load();
  if (journal.data.threadId) {
    emit({ event: 'existing_session_preserved', ...journal.status() });
  } else {
    client = await NativeClient.open();
    const controller = new NativeController({ client, journal,
      cwd: fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, ''), emit });
    await controller.prepare();
    emit({ event: 'dedicated_session_created', ...journal.status() });
  }
} catch (error) {
  const reason = /^[a-z_]+$/.test(error.message) ? error.message : 'session_init_requires_review';
  if (journal) await journal.update(data => { data.phase = 'paused'; data.pauseReason = reason; }).catch(() => {});
  emit({ event: 'session_init_stopped', reason }); process.exitCode = 1;
} finally { client?.close(); await release(); }
