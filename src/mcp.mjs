import { attachJsonLines, sendJsonLine } from './framing.mjs';

const VERSION = '2026-07-28';
const SERVER_INFO = { name: 'wechat-codex-bridge', version: '0.1.0' };
const replyTool = {
  name: 'reply_to_wechat_request',
  title: 'Reply to the current WeChat request',
  description: 'Send one text reply to the bound WeChat user for a pending requestId from a wechat.message.created event. A request expires after 24 hours. Acceptance by the WeChat API is not a delivery receipt.',
  inputSchema: { type: 'object', properties: { requestId: { type: 'string' }, text: { type: 'string', maxLength: 800 } }, required: ['requestId', 'text'], additionalProperties: false },
  annotations: { destructiveHint: false, openWorldHint: true, idempotentHint: true },
};

function errorResponse(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }
function successResponse(id, result) { return { jsonrpc: '2.0', id, result }; }

export function createMcpHandler(bridge) {
  return async function handle(message) {
    if (!message || message.jsonrpc !== '2.0' || !('id' in message)) return null;
    const { id, method, params = {} } = message;
    try {
      if (method !== 'server/discover' && params?._meta?.['io.modelcontextprotocol/protocolVersion'] !== VERSION) {
        return { jsonrpc: '2.0', id, error: { code: -32022, message: 'Unsupported protocol version', data: { supported: [VERSION], requested: params?._meta?.['io.modelcontextprotocol/protocolVersion'] ?? null } } };
      }
      switch (method) {
        case 'server/discover':
          return successResponse(id, { resultType: 'complete', supportedVersions: [VERSION], capabilities: { tools: {}, events: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO }, instructions: 'The only sender is the owner-bound WeChat user. For an incoming event, reply only with reply_to_wechat_request using its requestId. A webhook receipt is not a WeChat delivery receipt.' });
        case 'ping': return successResponse(id, { resultType: 'complete' });
        case 'tools/list': return successResponse(id, { resultType: 'complete', tools: [replyTool] });
        case 'events/list': return successResponse(id, { resultType: 'complete', events: bridge.listEvents() });
        case 'events/subscribe': return successResponse(id, { resultType: 'complete', ...(await bridge.subscribe(params)) });
        case 'events/unsubscribe': return successResponse(id, { resultType: 'complete', ...(await bridge.unsubscribe(params)) });
        case 'tools/call': {
          if (params.name !== replyTool.name || !params.arguments || Object.keys(params.arguments).some((key) => !['requestId', 'text'].includes(key))) return errorResponse(id, -32602, 'invalid tool arguments');
          try {
            const result = await bridge.reply(params.arguments.requestId, params.arguments.text);
            return successResponse(id, { resultType: 'complete', content: [{ type: 'text', text: result.duplicate ? 'Already accepted; not sent again.' : 'WeChat API accepted the message; delivery is not confirmed.' }], structuredContent: result, isError: false });
          } catch (error) {
            return successResponse(id, { resultType: 'complete', content: [{ type: 'text', text: error.message }], isError: true });
          }
        }
        default: return errorResponse(id, -32601, 'method not found');
      }
    } catch (error) {
      if (method === 'events/subscribe' && /callback|challenge/i.test(error.message)) {
        return { jsonrpc: '2.0', id, error: { code: -32015, message: 'Callback endpoint error', data: { reason: /timeout/i.test(error.message) ? 'timeout' : 'challenge_failed' } } };
      }
      return errorResponse(id, -32602, error.message);
    }
  };
}

export function startStdioMcp(handle, input = process.stdin, output = process.stdout) {
  attachJsonLines(input, (message) => {
    void handle(message).then((response) => { if (response) sendJsonLine(output, response); }).catch((error) => {
      if ('id' in message) sendJsonLine(output, errorResponse(message.id, -32603, error.message));
    });
  }, (error) => process.stderr.write(`MCP frame rejected: ${error.message}\n`));
}
