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
import { processInput, getChargeForTokens } from './input.js';
import { log } from './logger.js';
import { MCPClient } from './mcpClient.js';
import type { TokenCharger, Input } from './types.js';

await Actor.init();

/**
 * Charge for token usage
 * We don't want to implement this in the MCPClient as we want to have MCP Client independent of Apify Actor
 */
export class ActorTokenCharger implements TokenCharger {
    async chargeTokens(inputTokens: number, outputTokens: number, modelName: string): Promise<void> {
        const eventNameInput = modelName === 'claude-3-5-haiku-latest'
            ? Event.INPUT_TOKENS_HAIKU_3_5
            : Event.INPUT_TOKENS_SONNET_3_7;
        const eventNameOutput = modelName === 'claude-3-5-haiku-latest'
            ? Event.OUTPUT_TOKENS_HAIKU_3_5
            : Event.OUTPUT_TOKENS_SONNET_3_7;
        try {
            await Actor.charge({ eventName: eventNameInput, count: Math.ceil(inputTokens / 100) });
            await Actor.charge({ eventName: eventNameOutput, count: Math.ceil(outputTokens / 100) });
            log.info(`Charged ${inputTokens} input tokens (query+tools) and ${outputTokens} output tokens`);
        } catch (error) {
            log.error('Failed to charge for token usage', { error });
            throw error;
        }
    }
}

// Add after Actor.init()
const RUNNING_TIME_INTERVAL = 5 * 60 * 1000; // 5 minutes in milliseconds
setInterval(async () => {
    try {
        log.info(`Charging for running time (every 5 minutes)`);
        await Actor.charge({ eventName: Event.ACTOR_RUNNING_TIME });
    } catch (error) {
        log.error('Failed to charge for running time', { error });
    }
}, RUNNING_TIME_INTERVAL);

try {
    // Charge for memory usage on start
    log.info(`Charging Actor start event.`);
    await Actor.charge({ eventName: Event.ACTOR_STARTED });
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

// Current runtime settings that can be modified
let runtimeSettings = {
    mcpSseUrl: input.mcpSseUrl,
    systemPrompt: input.systemPrompt,
    modelName: input.modelName,
    modelMaxOutputTokens: input.modelMaxOutputTokens,
    maxNumberOfToolCallsPerQuery: input.maxNumberOfToolCallsPerQuery,
    toolCallTimeoutSec: input.toolCallTimeoutSec,
};

if (!input.llmProviderApiKey) {
    log.error('No API key provided for LLM provider. Report this issue to Actor developer.');
    await Actor.exit('No API key provided for LLM provider. Report this issue to Actor developer.');
}

// 4) We'll store the SSE clients (browsers) in an array
type SSEClient = { id: number; res: express.Response };
let sseClients: SSEClient[] = [];
let clientIdCounter = 0;

// Create a single instance of your MCP client (client is connected to the MCP-server)
const client = new MCPClient(
    input.mcpSseUrl,
    input.headers,
    input.systemPrompt,
    input.modelName,
    input.llmProviderApiKey,
    input.modelMaxOutputTokens,
    input.maxNumberOfToolCallsPerQuery,
    input.toolCallTimeoutSec,
    getChargeForTokens() ? new ActorTokenCharger() : null,
);

// 5) SSE endpoint for the client.js (browser)
app.get('/sse', (req, res) => {
    // Required headers for SSE
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // Disable proxy buffering
    });
    res.flushHeaders();

    const clientId = ++clientIdCounter;
    const keepAliveInterval = setInterval(() => {
        res.write(':\n\n'); // Send a comment as a keepalive
    }, 5000); // Send keepalive every 5 seconds

    sseClients.push({ id: clientId, res });
    log.debug(`New SSE client: ${clientId}`);

    // If client closes connection, remove from array and clear interval
    req.on('close', () => {
        log.debug(`SSE client disconnected: ${clientId}`);
        clearInterval(keepAliveInterval);
        sseClients = sseClients.filter((c) => c.id !== clientId);
    });

    // Handle client timeout
    req.on('timeout', () => {
        log.debug(`SSE client timeout: ${clientId}`);
        clearInterval(keepAliveInterval);
        sseClients = sseClients.filter((c) => c.id !== clientId);
        res.end();
    });
});

// 6) POST /message from the browser to server
app.post('/message', async (req, res) => {
    const { query } = req.body;
    if (!query) {
        return res.status(400).json({ error: 'Missing "query" field' });
    }
    try {
        // Process the query
        await Actor.pushData({ role: 'user', content: query });
        await client.processUserQuery(query, async (role, content) => {
            await broadcastSSE({ role, content });
        });
        // Charge for task completion
        await Actor.charge({ eventName: Event.QUERY_ANSWERED, count: 1 });
        log.info(`Charged query answered event`);
        return res.json({ ok: true });
    } catch (err) {
        log.error(`Error in processing user query: ${err}, conversation: ${client.getConversation()}`);
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

// GET /settings endpoint to retrieve current settings
app.get('/settings', (_req, res) => {
    res.json(runtimeSettings);
});

// POST /settings endpoint to update settings
app.post('/settings', async (req, res): Promise<void> => {
    try {
        const newSettings = req.body;
        // Validate required fields
        if (!newSettings.mcpSseUrl) {
            res.status(400).json({ success: false, error: 'MCP SSE URL is required' });
            return;
        }
        if (!newSettings.modelName) {
            res.status(400).json({ success: false, error: 'Model name is required' });
            return;
        }
        runtimeSettings = {
            ...runtimeSettings,
            ...newSettings,
        };

        await client.updateClientSettings(runtimeSettings);
        res.json({ success: true });
    } catch (error) {
        log.error('Error updating settings:', { error: (error instanceof Error) ? error.message : String(error) });
        res.status(500).json({ success: false, error: 'Failed to update settings' });
    }
});

// POST /settings/reset endpoint to reset settings to defaults
app.post('/settings/reset', async (_req, res) => {
    try {
        runtimeSettings = {
            mcpSseUrl: input.mcpSseUrl,
            systemPrompt: input.systemPrompt,
            modelName: input.modelName,
            modelMaxOutputTokens: input.modelMaxOutputTokens,
            maxNumberOfToolCallsPerQuery: input.maxNumberOfToolCallsPerQuery,
            toolCallTimeoutSec: input.toolCallTimeoutSec,
        };
        await client.updateClientSettings(runtimeSettings);
        res.json({ success: true });
    } catch (error) {
        log.error('Error resetting settings:', { error: (error instanceof Error) ? error.message : String(error) });
        res.status(500).json({ success: false, error: 'Failed to reset settings' });
    }
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
 * GET /available-tools endpoint to fetch available tools
 */
app.get('/available-tools', async (_req, res) => {
    try {
        await client.connectToServer(); // Ensure connected
        await client.updateTools(); // Refresh tools
        const tools = client.getTools ? client.getTools() : [];
        res.json({ tools });
    } catch (err) {
        log.error(`Error fetching tools: ${err}`);
        res.status(500).json({ error: 'Failed to fetch tools' });
    }
});

app.get('*', (_req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
});

/**
 * Broadcasts an event to all connected SSE clients
 */
async function broadcastSSE(data: object) {
    await Actor.pushData(data);
    for (const c of sseClients) {
        c.res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
}

app.listen(PORT, async () => {
    log.info(`Serving from path ${path.join(publicPath, 'index.html')}`);
    const msg = `Navigate to ${publicUrl} to interact with chat-ui interface.`;
    log.info(msg);
    await Actor.pushData({ content: msg, role: publicUrl });
});
