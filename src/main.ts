/**
 * # Chatbot Server with Real-Time Tool Execution
 *
 * Server for a chatbot integrated with Apify Actors and an MCP client.
 * Processes user queries, invokes tools dynamically, and streams real-time updates using Server-Sent Events (SSE)
 *
 * Environment variables:
 * - `APIFY_TOKEN` - API token for Apify (when using actors-mcp-server)
 */

import path from 'path';
import { fileURLToPath } from 'url';

import { Actor } from 'apify';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';

import { BASIC_INFORMATION, Event } from './const.js';
import { processInput, isChargingForQueryAnswered } from './input.js';
import { log } from './logger.js';
import { MCPClient } from './mcpClient.js';
import type { Input } from './types.js';

await Actor.init();

// Add after Actor.init()
const RUNNING_TIME_INTERVAL = 5 * 60 * 1000; // 5 minutes in milliseconds
setInterval(async () => {
    try {
        const memoryMB = Actor.getEnv().memoryMbytes || 128;
        const memoryMBCount = Math.ceil(memoryMB / 128);
        log.info(`Charging for running time (every 5 minutes): ${memoryMB} MB`);
        await Actor.charge({ eventName: Event.ACTOR_RUNNING_TIME, count: memoryMBCount });
    } catch (error) {
        log.error('Failed to charge for running time', { error });
    }
}, RUNNING_TIME_INTERVAL);

try {
    // Charge for memory usage on start
    const memoryMB = Actor.getEnv().memoryMbytes || 128;
    const memoryMBCount = Math.ceil(memoryMB / 128);
    log.info(`Required memory: ${memoryMB} MB. Charging Actor start event.`);
    await Actor.charge({ eventName: Event.ACTOR_STARTED, count: memoryMBCount });
} catch (error) {
    log.error('Failed to charge for actor start event', { error });
    await Actor.exit('Failed to charge for actor start event');
}

const STANDBY_MODE = Actor.getEnv().metaOrigin === 'STANDBY';
const ACTOR_IS_AT_HOME = Actor.isAtHome();
let HOST: string | undefined;
let PORT: string | undefined;

if (ACTOR_IS_AT_HOME) {
    HOST = STANDBY_MODE ? process.env.ACTOR_STANDBY_URL : process.env.ACTOR_WEB_SERVER_URL;
    PORT = ACTOR_IS_AT_HOME ? process.env.ACTOR_STANDBY_PORT : process.env.ACTOR_WEB_SERVER_PORT;
} else {
    const filename = fileURLToPath(import.meta.url);
    const dirname = path.dirname(filename);
    dotenv.config({ path: path.resolve(dirname, '../.env') });
    HOST = 'http://localhost';
    PORT = '3000';
}

// Add near the top after Actor.init()
let ACTOR_TIMEOUT_AT: number | undefined;
try {
    ACTOR_TIMEOUT_AT = process.env.ACTOR_TIMEOUT_AT ? new Date(process.env.ACTOR_TIMEOUT_AT).getTime() : undefined;
} catch {
    ACTOR_TIMEOUT_AT = undefined;
}

const app = express();
app.use(express.json());
app.use(cors());

// Serve your public folder (where index.html is located)
const filename = fileURLToPath(import.meta.url);
const publicPath = path.join(path.dirname(filename), 'public');
const publicUrl = ACTOR_IS_AT_HOME ? HOST : `${HOST}:${PORT}`;
app.use(express.static(publicPath));

const input = processInput((await Actor.getInput<Partial<Input>>()) ?? ({} as Input));
log.debug(`systemPrompt: ${input.systemPrompt}`);
log.debug(`mcpSseUrl: ${input.mcpSseUrl}`);
log.debug(`modelName: ${input.modelName}`);

if (!input.llmProviderApiKey) {
    log.error('No API key provided for LLM provider. Report this issue to Actor developer.');
    await Actor.exit('No API key provided for LLM provider. Report this issue to Actor developer.');
}

// 4) We'll store the SSE clients (browsers) in an array
type SSEClient = { id: number; res: express.Response };
let sseClients: SSEClient[] = [];
let clientIdCounter = 0;
let totalTokenUsageInput = 0;
let totalTokenUsageOutput = 0;

// Create a single instance of your MCP client
const client = new MCPClient(
    input.mcpSseUrl,
    input.headers,
    input.systemPrompt,
    input.modelName,
    input.llmProviderApiKey,
    input.modelMaxOutputTokens,
    input.maxNumberOfToolCallsPerQuery,
    input.toolCallTimeoutSec,
);

// 5) SSE endpoint for the client.js (browser) to connect to
app.get('/sse', (req, res) => {
    // Required headers for SSE
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
    });
    res.flushHeaders();

    const clientId = ++clientIdCounter;
    sseClients.push({ id: clientId, res });
    log.debug(`New SSE client: ${clientId}`);

    // If client closes connection, remove from array
    req.on('close', () => {
        log.debug(`SSE client disconnected: ${clientId}`);
        sseClients = sseClients.filter((c) => c.id !== clientId);
    });
});

// 6) POST /message from the browser
app.post('/message', async (req, res) => {
    const { query } = req.body;
    if (!query) {
        return res.status(400).json({ error: 'Missing "query" field' });
    }
    try {
        // Process the query
        const response = await client.processUserQuery(query, (role, content) => {
            broadcastSSE({ role, content });
        });

        log.debug(`[internal] Token usage: ${JSON.stringify(response.usage)}`);
        // accumulate token usage for the whole run
        totalTokenUsageInput += response.usage?.input_tokens ?? 0;
        totalTokenUsageOutput += response.usage?.output_tokens ?? 0;
        log.debug(`[internal] Total token usage: ${totalTokenUsageInput} input, ${totalTokenUsageOutput} output`);

        // Charge for task completion
        if (isChargingForQueryAnswered) {
            log.info(`Charging query answered event wth ${input.modelName} model`);
            const eventName = input.modelName === 'claude-3-5-haiku-latest' ? Event.QUERY_ANSWERED_HAIKU_3_5 : Event.QUERY_ANSWERED_SONNET_3_7;
            await Actor.charge({ eventName });
        }

        return res.json({ ok: true });
    } catch (err) {
        log.error(`Error in processing user query: ${err}`);
        return res.json({ error: (err as Error).message });
    }
});

/**
 * Periodically check if the main server is still reachable.
 */
app.get('/pingMcpServer', async (_req, res) => {
    try {
        // Attempt to ping the main MCP server
        const response = await client.isConnected();
        res.json({ status: response });
    } catch (err) {
        res.json({ status: 'Not connected', error: (err as Error).message });
    }
});

app.post('/reconnect', async (_req, res) => {
    try {
        log.debug('Reconnecting to main server');
        await client.connectToServer();
        const response = await client.isConnected();
        res.json({ status: response });
    } catch (err) {
        log.error(`Error reconnecting to main server: ${err}`);
        res.json({ status: 'Not connected', error: (err as Error).message });
    }
});

/**
 * GET /client-info endpoint to provide the client with necessary information
 */
app.get('/client-info', (_req, res) => {
    res.json({
        mcpSseUrl: input.mcpSseUrl,
        systemPrompt: input.systemPrompt,
        modelName: input.modelName,
        publicUrl,
        information: BASIC_INFORMATION,
    });
});

/**
 * GET /check-timeout endpoint to check if the actor is about to timeout
 */
app.get('/check-actor-timeout', (_req, res) => {
    if (!ACTOR_TIMEOUT_AT) {
        return res.json({ timeoutImminent: false });
    }

    const now = Date.now();
    const timeUntilTimeout = ACTOR_TIMEOUT_AT - now;
    const timeoutImminent = timeUntilTimeout < 60000; // Less than 1 minute remaining

    return res.json({
        timeoutImminent,
        timeUntilTimeout,
        timeoutAt: ACTOR_TIMEOUT_AT,
    });
});

/**
 * POST /conversation/reset to reset the conversation
 */
app.post('/conversation/reset', (_req, res) => {
    client.resetConversation();
    res.json({ ok: true });
});

/**
 * Broadcasts an event to all connected SSE clients
 */
function broadcastSSE(data: object) {
    for (const c of sseClients) {
        c.res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
}

app.get('*', (_req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
});

app.listen(PORT, () => {
    log.info(`Serving from path ${path.join(publicPath, 'index.html')}`);
    log.info(`Navigate to ${publicUrl} in your browser to interact with an MCP server.`);
});
