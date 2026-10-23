import { parentPort } from 'node:worker_threads';
import { retrieveMemories } from './retriever.mjs';

const embeddingCalls = new Map();
const controllers = new Map();
let sequence = 0;
const failure = error => ({ name: error.name, message: error.message, code: error.code, stack: error.stack });
parentPort.on('message', async message => {
  if (message.type === 'cancel') {
    controllers.get(message.id)?.abort();
    for (const [id, pending] of embeddingCalls) if (pending.jobId === message.id) {
      embeddingCalls.delete(id); pending.reject(new DOMException('Retrieval cancelled.', 'AbortError'));
    }
    return;
  }
  if (message.type === 'embedding-result') {
    const pending = embeddingCalls.get(message.callId);
    if (!pending) return;
    embeddingCalls.delete(message.callId);
    if (message.error) pending.reject(Object.assign(new Error(message.error.message), message.error));
    else pending.resolve(message.value);
    return;
  }
  if (message.type !== 'retrieve') return;
  const { id, input, embedding } = message;
  const controller = new AbortController();
  controllers.set(id, controller);
  try {
    const embeddingProvider = embedding ? text => new Promise((resolve, reject) => {
      const callId = ++sequence;
      embeddingCalls.set(callId, { resolve, reject, jobId: id });
      parentPort.postMessage({ type: 'embedding', id, callId, text });
    }) : null;
    const value = await retrieveMemories({ ...input, embeddingProvider, signal: controller.signal });
    parentPort.postMessage({ type: 'result', id, value });
  } catch (error) { parentPort.postMessage({ type: 'result', id, error: failure(error) }); }
  finally { controllers.delete(id); }
});
