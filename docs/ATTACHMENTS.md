# Owner-bound attachments

The local queue accepts direct image/file items from the bound owner after the existing activation watermark. Attachments use the same request mapping and reply deduplication as text.

| Type | Formats | Maximum decrypted size |
|---|---|---:|
| Image | PNG, JPEG, GIF, WebP | 10 MiB |
| PDF | `.pdf` | 20 MiB |
| Word | `.docx`, `.doc` | 20 MiB |
| Excel | `.xlsx`, `.xls` | 20 MiB |
| UTF-8 text | `.txt`, `.md`, `.csv`, `.tsv` | 20 MiB |

Extensions must match inspected signatures. OOXML archive structure is checked without extraction, and `vbaProject.bin` is rejected. Other archives, executables, voice, video and quoted attachments are unsupported. At most eight media items are processed per message. Intake checks are not a malware verdict.

CDN downloads use HTTPS on Tencent CDN hosts under `/c2c/`. DNS results must be public and are pinned for the TLS request; redirects are rejected. Encrypted size, decrypted size and supplied size metadata are bounded. AES keys and credential-bearing query parameters are kept private and removed from pending transport references after completion or permanent failure.

Saved files use generated request/attachment IDs instead of sender filenames, under the private runtime `attachments/` directory. Files are mode 0600, directories 0700. An existing file is reused only after checking type, size and SHA-256. Saved attachments are not automatically deleted.

Before model input, the controller rechecks the private owner claim, path, ownership, mode, digest and content signature. Images are passed using CLI `--image`; documents provide only their verified local metadata/path. Filename and document contents are data, not instructions or permission grants. Macros, embedded executables and automatic archive extraction are not run.

A transient download can retry up to three times using the original request and attachment IDs. Permanent validation failures expose a short generic failure code. This does not independently send a WeChat reply.

Real image/document end-to-end processing still needs a small owner-supplied test for the installed CLI version. Keep extraction limited to the actual request, and do not expose private attachment paths or full files in public diagnostics.
