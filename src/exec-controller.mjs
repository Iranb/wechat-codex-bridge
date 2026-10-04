import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { NativeController, marker, recoverModel } from './native-controller.mjs';
import { MODEL } from './native-client.mjs';
import { ExecClient } from './exec-client.mjs';

export class ExecController extends NativeController {
  constructor(options) { super(options); this.exec = options.exec || new ExecClient(); }
  async inspect() {
    const threadId = this.journal.data.threadId;
    if (!threadId || this.journal.data.model !== MODEL) throw new Error('existing_dedicated_thread_required');
    const { thread } = await this.client.request('thread/read', { threadId, includeTurns: true });
    if (thread.id !== threadId || thread.model !== MODEL) throw new Error('exec_thread_model_mismatch');
    if ((thread.turns || []).some(turn => turn.status === 'inProgress')) throw new Error('dedicated_thread_not_idle');
    const queue = await this.client.request('thread/queue/list', { threadId, limit: 100 });
    if (queue.data.length || queue.nextCursor) throw new Error('native_queue_not_empty');
    return thread;
  }
  async prepare() {
    await this.client.requireModel();
    const thread = await this.inspect();
    const active = this.journal.data.active;
    if (active?.delivery === 'cli_queue' && active.stage === 'submitting') {
      const matches = (thread.turns || []).filter(turn => (turn.items || []).some(item => item.type === 'userMessage' &&
        (item.content || []).some(part => part.type === 'text' && part.text.startsWith(marker(active.requestId) + '\n'))));
      if (matches.length) throw new Error('old_queue_submission_requires_reconciliation');
      // Absence is not proof that the old CLI submission never happened.
      // Keep its entire private recovery record, and explicitly exclude it from
      // all later claims, even after its lease expires. Never reset/replay it.
      await this.journal.update(data => {
        data.quarantined ||= [];
        if (data.quarantined.length >= 100) throw new Error('quarantine_review_required');
        data.quarantined.push({ ...data.active, reason: 'native_queue_submission_unconfirmed',
          receiveDir: data.receiveDir, checkedAt: new Date().toISOString(), evidence: { matchingTurns: 0, queuedSubmissions: 0 } });
        data.active = null; data.receiveDir = null;
      });
      this.emit({ event: 'exec_old_request_quarantined', requestId: active.requestId });
    }
    await this.journal.update(data => { data.transport = 'codex-exec'; });
    return this.journal.status();
  }
  async completedReply(active) {
    const { thread } = await this.client.request('thread/read', { threadId: this.journal.data.threadId, includeTurns: true });
    if (thread.model !== MODEL) throw new Error('exec_thread_model_mismatch');
    const matches = (thread.turns || []).filter(turn => (active.turnId ? turn.id === active.turnId : (turn.items || []).some(item =>
      item.type === 'userMessage' && (item.content || []).some(part => part.type === 'text' && part.text.startsWith(marker(active.requestId) + '\n')))));
    if (matches.length !== 1 || matches[0].status !== 'completed') throw new Error('exec_submission_unconfirmed');
    return recoverModel(this.client, this.journal.data.threadId, active);
  }
  async probe(signal, { newProbe = false } = {}) {
    if (newProbe) {
      const previous = this.journal.data.cliProbe;
      if (this.journal.data.active || previous?.stage !== 'second_submitting' || this.journal.data.pauseReason !== 'exec_context_probe_failed') throw new Error('new_probe_not_authorized_by_state');
      // A deliberately requested new diagnostic attempt is allowed only after
      // BOTH original submissions are confirmed completed. It is never an
      // automatic retry, and all old probe metadata remains in the journal.
      await this.completedReply({ requestId: previous.firstId });
      await this.completedReply({ requestId: previous.secondId });
      await this.journal.update(data => { data.cliProbeAttempts ||= []; data.cliProbeAttempts.push({ ...data.cliProbe, outcome: 'context_not_verified' }); data.cliProbe = null; });
    }
    if (this.journal.data.cliProbe?.stage === 'completed') return { status: 'already_verified' };
    if (!this.journal.data.cliProbe) await this.journal.update(data => {
      data.cliProbe = { stage: 'ready', nonce: `青松映月${randomUUID().slice(0, 8)}`,
        firstId: `probe_${randomUUID()}`, secondId: `probe_${randomUUID()}` };
    });
    const probe = this.journal.data.cliProbe;
    const run = async (key, prompt) => {
      const id = probe[`${key}Id`];
      const outputPath = join(dirname(this.journal.path), `${id}.txt`);
      await this.journal.update(data => { data.cliProbe.stage = `${key}_submitting`; });
      const result = await this.exec.run({ threadId: this.journal.data.threadId, cwd: this.cwd, outputPath, signal,
        input: [{ type: 'text', text: `${marker(id)}\n以下 JSON 的 text 是主人的接通测试指令，不含私人信息。\n${JSON.stringify({ text: prompt, attachments: [] })}` }], emit: this.emit });
      const recovered = await this.completedReply({ requestId: id });
      if (recovered.reply !== result.reply || (key === 'second' && result.reply !== probe.nonce)) throw new Error('exec_context_probe_failed');
    };
    if (probe.stage === 'ready') {
      await run('first', `这是无私人信息的 CLI 续接测试。记住校验短语 ${probe.nonce}。不要调用工具，仅回复该短语。`);
      await this.journal.update(data => { data.cliProbe.stage = 'first_completed'; });
    } else if (probe.stage === 'first_submitting') {
      const result = await this.completedReply({ requestId: probe.firstId });
      // The first response can acknowledge the phrase instead of echoing it.
      // It only needs a uniquely confirmed completion; the second invocation
      // must retrieve the exact phrase without receiving it again.
      await this.journal.update(data => { data.cliProbe.stage = 'first_completed'; });
    }
    if (this.journal.data.cliProbe.stage === 'first_completed') {
      await run('second', '这是同一会话的第二次 CLI 测试。不要调用工具，仅回复上一轮要求记住的校验短语。');
    } else if (this.journal.data.cliProbe.stage === 'second_submitting') {
      const result = await this.completedReply({ requestId: probe.secondId });
      if (result.reply !== probe.nonce) throw new Error('exec_context_probe_failed');
    } else throw new Error('exec_probe_requires_review');
    await this.journal.update(data => { data.cliProbe.stage = 'completed'; });
    return { status: 'verified', sameThreadContext: true };
  }
  async generate(claim, signal) {
    await this.inspect();
    const input = await this.buildInput(claim, { statePath: this.statePath });
    const outputPath = join(dirname(claim.claimFile), 'exec-final.txt');
    await this.journal.update(data => { data.active.stage = 'submitting'; data.active.delivery = 'codex_exec'; data.active.outputPath = outputPath; });
    const result = await this.exec.run({ threadId: this.journal.data.threadId, cwd: this.cwd, input, outputPath, signal,
      onStarted: () => this.journal.update(data => { data.active.stage = 'running'; }), emit: this.emit });
    const recovered = await this.completedReply(this.journal.data.active);
    if (recovered.reply !== result.reply) throw new Error('exec_final_reply_mismatch');
    await this.journal.update(data => { data.active.turnId = recovered.turn.id; });
    return result.reply;
  }
  async processActive(signal) {
    const active = this.journal.data.active;
    if (active.delivery === 'codex_exec' && ['submitting', 'running'].includes(active.stage)) {
      // A crashed CLI is never re-executed. Only a uniquely matched, persisted
      // completed turn can cross the existing guarded WeChat send boundary.
      const result = await this.completedReply(active);
      signal?.throwIfAborted();
      await this.renew();
      await this.journal.update(data => { data.active.reply = result.reply; data.active.turnId = result.turn.id; data.active.stage = 'prepared'; });
      return this.deliver();
    }
    return super.processActive(signal);
  }
}
