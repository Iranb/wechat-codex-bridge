# Security and privacy

This bridge processes private WeChat messages and uses local authenticated runtimes. Report a vulnerability through GitHub's private vulnerability reporting when available. A public issue should contain only a sanitized reproduction with synthetic inputs, never account tokens, message bodies, context tokens, session IDs, private paths or attachments.

Runtime credentials, pending messages and claims stay outside the source repository. `.gitignore` and the release checker prevent common runtime files from being staged. Tests use synthetic accounts, messages and transports. Neither source publication nor CI requires real WeChat/Codex credentials.

Sender binding, request mapping, claim leases, reply digests and submission/send journals restrict replies to the original bound-owner request. Unexpected model/thread changes, uncertain submissions and uncertain sends fail closed. Never delete a journal or lock simply to bypass a pause.

The model uses read-only execution with user approval; this does not itself prevent all file reads or prompt injection. Treat received content as untrusted, limit local access to the requested files, protect private runtime directories and review operations requiring more permissions. Automatic approval is not enabled.

Pending state has a 24-hour reply/content lifetime and 30-day deduplication retention. Saved attachments, receive control directories and recovery journals can retain private content longer; set an appropriate local cleanup policy. Do not publish runtime backups or logs when sharing a repository.
