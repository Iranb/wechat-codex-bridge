export function attachJsonLines(stream, onMessage, onError) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > 1_048_576) {
      onError(new Error('frame too large'));
      stream.destroy?.();
      return;
    }
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try { onMessage(JSON.parse(line)); }
      catch (error) { onError(error); }
    }
  });
}

export function sendJsonLine(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}
