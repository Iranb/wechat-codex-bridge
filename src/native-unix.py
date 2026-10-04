#!/usr/bin/env python3
"""JSONL adapter for the documented local app-server Unix WebSocket transport.

It uses the already-installed websockets package. It never handles auth tokens,
reads account files, logs native payloads, or stops the shared daemon.
"""
import sys
import threading
from websockets.sync.client import unix_connect

LIMIT = 1048576


def main():
    with unix_connect(sys.argv[1], uri="ws://localhost/", open_timeout=10,
                      close_timeout=2, max_size=LIMIT, compression=None) as ws:
        def send_input():
            try:
                while True:
                    line = sys.stdin.buffer.readline(LIMIT + 1)
                    if not line:
                        break
                    if len(line) > LIMIT or not line.endswith(b"\n"):
                        break
                    ws.send(line[:-1].decode("utf-8"))
            except Exception:
                pass
            finally:
                ws.close()
        threading.Thread(target=send_input, daemon=True).start()
        for message in ws:
            if not isinstance(message, str) or len(message.encode("utf-8")) > LIMIT:
                break
            sys.stdout.write(message + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.stderr.write("native_unix_transport_failed\n")
        sys.exit(1)
