import { spawn } from 'node:child_process';
import { lstat, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { attachJsonLines } from './framing.mjs';
import { CODEX, MODEL, INSTRUCTIONS, rpcError } from './native-client.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function execArguments({ threadId, cwd, outputPath, images = [] }) {
  if (!UUID.test(threadId || '') || !cwd?.startsWith('/') || !outputPath?.startsWith('/')) throw new Error('exec_target_required');
  if (!images.every(path => typeof path === 'string' && path.startsWith('/'))) throw new Error('exec_image_invalid');
  return ['exec', '--sandbox', 'read-only', '--cd', cwd, '--color', 'never',
    ...['apps', 'plugins', 'multi_agent', 'computer_use', 'browser_use', 'in_app_browser', 'image_generation'].flatMap(feature => ['--disable', feature]),
    '-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="user"',
    '-c', 'model_reasoning_effort="low"',
    '-c', `developer_instructions=${JSON.stringify(INSTRUCTIONS.replace('最终回复用中文，', '最终回复默认用中文；用户明确要求原样返回短语时保留原文。'))}`,
    'resume', '--model', MODEL, '--json', '--skip-git-repo-check', '--output-last-message', outputPath,
    ...images.flatMap(path => ['--image', path]), threadId, '-'];
}

// stdout is parsed in memory and stderr is classified without retaining or
// printing its contents. Private input is sent only over stdin, never argv.
export class ExecClient {
  constructor({ executable = CODEX, spawnChild = spawn, timeoutMs = 300_000 } = {}) {
    Object.assign(this, { executable, spawnChild, timeoutMs });
  }
  async run({ threadId, cwd, outputPath, input, signal, onStarted = async () => {}, emit = () => {} }) {
    if (!Array.isArray(input) || input[0]?.type !== 'text' || input.slice(1).some(p => p.type !== 'localImage')) throw new Error('exec_input_invalid');
    signal?.throwIfAborted();
    const directory = await lstat(dirname(outputPath));
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || (directory.mode & 0o077)) throw new Error('exec_private_directory_required');
    const output = await open(outputPath, 'wx', 0o600);
    await output.close();
    const args = execArguments({ threadId, cwd, outputPath, images: input.slice(1).map(p => p.path) });
    return new Promise((resolve, reject) => {
      let child;
      try { child = this.spawnChild(this.executable, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false }); }
      catch { reject(new Error('exec_spawn_failed')); return; }
      let failure, started = false, completed = false, completionCount = 0, turnCount = 0;
      const messages = new Map();
      let usage = null, stderrTail = '', stderrFailure, killTimer;
      const fail = reason => {
        failure ||= reason;
        child.kill('SIGTERM');
        killTimer ||= setTimeout(() => child.kill('SIGKILL'), 3000);
        killTimer.unref?.();
      };
      const abort = () => fail('exec_submission_unconfirmed');
      const timer = setTimeout(() => fail('exec_timeout_unconfirmed'), this.timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      child.stdin.on('error', () => fail('exec_submission_unconfirmed'));
      child.once('error', () => { failure ||= 'exec_spawn_failed'; });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => {
        stderrTail = (stderrTail + chunk).slice(-8192);
        const classified = rpcError({ message: stderrTail }, 'codex/exec').message;
        if (classified !== 'native_rpc_rejected') stderrFailure ||= classified;
        if (/approval.*(?:required|not supported)|cannot.*(?:approve|prompt)|user input.*required/i.test(stderrTail)) stderrFailure ||= 'exec_user_action_required';
      });
      attachJsonLines(child.stdout, event => {
        if (event.type === 'thread.started') {
          if (event.thread_id !== threadId) return fail('exec_thread_mismatch');
          started = true;
        } else if (event.type === 'turn.started') {
          if (++turnCount > 1) return fail('exec_multiple_turns');
        } else if (event.type === 'turn.completed') {
          completed = true; completionCount++;
          usage = Object.fromEntries(Object.entries(event.usage || {}).filter(([key, value]) =>
            ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens'].includes(key) && Number.isSafeInteger(value) && value >= 0));
        } else if (event.type === 'turn.failed' || event.type === 'error') {
          const classified = rpcError({ message: event.message || event.error?.message }, 'codex/exec').message;
          failure ||= classified === 'native_rpc_rejected' ? 'exec_turn_failed' : classified;
        } else if (event.type === 'model.rerouted' || event.type === 'model/rerouted') {
          return fail('exec_model_rerouted');
        } else if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
          messages.set(event.item.id, event.item);
        }
      }, () => fail('exec_protocol_unconfirmed'));
      child.once('spawn', () => {
        void Promise.resolve().then(onStarted).then(() => {
          if (signal?.aborted || failure) return fail(failure || 'exec_submission_unconfirmed');
          child.stdin.end(input[0].text);
        }).catch(() => fail('exec_journal_write_failed'));
      });
      child.once('close', async code => {
        clearTimeout(timer); clearTimeout(killTimer);
        signal?.removeEventListener('abort', abort);
        stderrTail = '';
        try {
          if (failure) throw new Error(failure);
          if (code !== 0) throw new Error(stderrFailure || 'exec_completion_unconfirmed');
          if (!started || !completed || turnCount !== 1 || completionCount !== 1) throw new Error('exec_completion_unconfirmed');
          const info = await lstat(outputPath);
          if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > 16_384) throw new Error('exec_final_reply_invalid');
          const reply = (await readFile(outputPath, 'utf8')).trim();
          const all = [...messages.values()];
          const finals = all.filter(item => item.phase === 'final_answer');
          const candidates = finals.length ? finals : all.filter(item => item.phase == null);
          const last = candidates.at(-1)?.text?.trim();
          if (!reply || reply.length > 800 || last !== reply) throw new Error('exec_final_reply_invalid');
          emit({ event: 'exec_turn_completed', threadId, model: MODEL, usage });
          resolve({ reply, usage });
        } catch (error) { reject(error); }
      });
      if (signal?.aborted) abort();
    });
  }
}
