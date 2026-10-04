# Runtime and recovery

The default private directory is `~/.local/share/wechat-codex-bridge/`. Its contents are never part of the source repository.

| File or directory | Purpose |
|---|---|
| `state.json` | WeChat account credentials, original request mappings, pending content and deduplication state |
| `codex-session.json` | Explicit dedicated Codex thread ID, model, probe status and active recovery record |
| `exec-controller.log` | Controller event metadata, status and usage counters; no prompt or reply bodies |
| `local-queue.sock` | Owner-private local queue IPC |
| `*.lock` | PID locks preventing multiple pollers/controllers |
| `wechat-codex-receive-*` | Private claim, acknowledgment, final output and outbox records for individual requests |
| `attachments/` | Verified owner attachment files |
| `probe_*.txt` | Non-sensitive local connection-test output |

State and claim files use mode 0600; private runtime directories use mode 0700. The bridge does not print WeChat account tokens, pending context tokens or native authentication payloads. Codex authentication is handled by its supported CLI implementation; this bridge does not inspect or copy CLI authentication files.

## Submission boundaries

1. Persist the owner claim before acknowledging it.
2. Persist the model submission stage before launching CLI execution. Message text travels over stdin, not command arguments.
3. Require the exact thread ID, a successful process exit, one completed turn and a final output matching the target thread's recorded result.
4. Persist the send boundary and reply digest before invoking WeChat.
5. If a result is uncertain, pause. Recover only a uniquely confirmed original result; never blindly invoke another model turn or repeat a send.

An uncertain prior CLI queue submission can be quarantined only after checking its exact dedicated thread and queue. Its recovery record is retained, and future claims explicitly exclude that request ID even when its lease expires. Quarantine is not proof that it never executed or that it completed.

The underlying queue preserves the activation watermark, original owner/request mapping, 24-hour reply expiry and 30-day deduplication policy. The ordinary poller removes expired message bodies/context tokens from its state. Saved attachments, private claim files, final outputs and recovery journals need a separate retention policy.

## Idle operation and permissions

Only Node waits for messages while idle. An incoming claim triggers one CLI execution. The configured model is checked explicitly; unavailable models or detected rerouting stop the route. Usage values are reported using the installed CLI's event semantics, without treating them as a billing receipt.

The controller uses a read-only sandbox and user approval reviewer. It disables unneeded apps, plugins, additional agents, browser/computer use and image generation for its own CLI invocation. These flags do not change global configuration or other sessions. Non-interactive approval continuation is not verified; do not enable automatic approval to work around it.

The dedicated thread must have a single writer. If another native client holds it, close that thread's view normally and review the original active request before resuming. Do not kill shared application processes or remove native session locks.

## Troubleshooting

Run `npm run exec:status` and check metadata in the controller log. Inspect stages in order: receive polling, owner claim, CLI completion, and WeChat API acceptance. Do not paste private state, claim files, prompts or replies into public issues.

`accepted` means the HTTP/business-error checks passed; it is not a handset delivery or read receipt. Record both the controller timeline and the user's actual receipt when testing. If a message is still in `reply_sending`, wait for its original result rather than submitting a duplicate.
