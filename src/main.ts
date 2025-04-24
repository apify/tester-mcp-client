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

import type { MessageParam } from '@anthropic-ai/sdk/resources/index.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Actor } from 'apify';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';

import { createClient } from './clientFactory.js';
import { BASIC_INFORMATION, CONVERSATION_RECORD_NAME, Event } from './const.js';
import { ConversationManager } from './conversationManager.js';
import { processInput, getChargeForTokens } from './input.js';
import { log } from './logger.js';
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
        log.info('Charging for running time (every 5 minutes)');
        await Actor.charge({ eventName: Event.ACTOR_RUNNING_TIME });
    } catch (error) {
        log.error('Failed to charge for running time', { error });
    }
}, RUNNING_TIME_INTERVAL);

try {
    log.info('Charging Actor start event.');
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
    PORT = '5001';
}

// Add near the top after Actor.init()
let ACTOR_TIMEOUT_AT: number | undefined;
try {
    ACTOR_TIMEOUT_AT = process.env.ACTOR_TIMEOUT_AT ? new Date(process.env.ACTOR_TIMEOUT_AT).getTime() : undefined;
} catch {
    ACTOR_TIMEOUT_AT = undefined;
}

const actorInput = (await Actor.getInput<Partial<Input>>()) ?? ({} as Input);
const input = processInput(actorInput ?? ({} as Input));

log.debug(`systemPrompt: ${input.systemPrompt}`);
log.debug(`mcpUrl: ${input.mcpUrl}`);
log.debug(`mcpTransport: ${input.mcpTransportType}`);
log.debug(`modelName: ${input.modelName}`);

if (!input.llmProviderApiKey) {
    log.error('No API key provided for LLM provider. Report this issue to Actor developer.');
    await Actor.exit('No API key provided for LLM provider. Report this issue to Actor developer.');
}

let runtimeSettings = {
    mcpUrl: input.mcpUrl,
    mcpTransportType: input.mcpTransportType,
    systemPrompt: input.systemPrompt,
    modelName: input.modelName,
    modelMaxOutputTokens: input.modelMaxOutputTokens,
    maxNumberOfToolCallsPerQuery: input.maxNumberOfToolCallsPerQuery,
    toolCallTimeoutSec: input.toolCallTimeoutSec,
};

const app = express();
app.use(express.json());
app.use(cors());

// Serve your public folder (where index.html is located)
const filename = fileURLToPath(import.meta.url);
const publicPath = path.join(path.dirname(filename), 'public');
const publicUrl = ACTOR_IS_AT_HOME ? HOST : `${HOST}:${PORT}`;
app.use(express.static(publicPath));

const persistedConversation = (await Actor.getValue<MessageParam[]>(CONVERSATION_RECORD_NAME)) ?? [];

const conversationManager = new ConversationManager(
    input.systemPrompt,
    input.modelName,
    input.llmProviderApiKey,
    input.modelMaxOutputTokens,
    input.maxNumberOfToolCallsPerQuery,
    input.toolCallTimeoutSec,
    getChargeForTokens() ? new ActorTokenCharger() : null,
    persistedConversation,
);

// This should not be needed, but just in case
Actor.on('migrating', async () => {
    log.debug(`Migrating ... persisting conversation.`);
    await Actor.setValue(CONVERSATION_RECORD_NAME, conversationManager.getConversation());
});

// Only one browser client can be connected at a time
type BrowserSSEClient = { id: number; res: express.Response };
let browserClients: BrowserSSEClient[] = [];
let nextClientId = 1;

// Create a single instance of your MCP client (client is connected to the MCP-server)
let client: Client | null = null;

// 5) SSE endpoint for the client.js (browser)
app.get('/sse', async (req, res) => {
    // Required headers for SSE
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // Disable proxy buffering
    });
    res.flushHeaders();

    const clientId = nextClientId++;
    const keepAliveInterval = setInterval(() => {
        res.write(':\n\n'); // Send a comment as a keepalive
    }, 5000); // Send keepalive every 5 seconds

    browserClients.push({ id: clientId, res });
    log.debug(`Browser client ${clientId} connected`);

    // If a client closes connection, clear an interval and remove from an array
    req.on('close', () => {
        log.debug(`Browser client ${clientId} disconnected`);
        clearInterval(keepAliveInterval);
        browserClients = browserClients.filter((browserClient) => browserClient.id !== clientId);
    });

    // Handle client timeout
    req.on('timeout', () => {
        log.debug(`Browser client ${clientId} timeout`);
        clearInterval(keepAliveInterval);
        browserClients = browserClients.filter((browserClient) => browserClient.id !== clientId);
        res.end();
    });
});

/**
 * Helper function to create or get existing MCP client
 * @returns Client instance or throws error
 */
async function getOrCreateClient(): Promise<Client> {
    if (!client) {
        try {
            client = await createClient(
                runtimeSettings.mcpUrl,
                runtimeSettings.mcpTransportType,
                input.headers,
                async (tools) => await conversationManager.handleToolUpdate(tools),
                (notification) => conversationManager.handleNotification(notification),
            );
        } catch (err) {
            const error = err as Error;
            log.error('Failed to connect to MCP server', { error: error.message, stack: error.stack });
            throw new Error(`${error.message}`);
        }
    }
    return client;
}

/**
 * Helper function to handle client cleanup based on transport type
 */
async function cleanupClient(): Promise<void> {
    if (input.mcpTransportType === 'http-streamable-json-response' && client) {
        try {
            await client.close();
            client = null;
        } catch (err) {
            const error = err as Error;
            log.error('Failed to close client connection', { error: error.message, stack: error.stack });
        }
    }
}

// /message endpoint for the client.js (browser)
app.post('/message', async (req, res) => {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Missing "query" field' });

    try {
        // Process the query
        await Actor.pushData({ role: 'user', content: query });
        const mcpClient = await getOrCreateClient();
        await conversationManager.processUserQuery(mcpClient, query, async (role, content) => {
            await broadcastSSE({ role, content });
        });
        // Charge for task completion
        await Actor.charge({ eventName: Event.QUERY_ANSWERED, count: 1 });
        log.info(`Charged query answered event`);

        await cleanupClient();
        return res.json({ ok: true });
    } catch (err) {
        const error = err as Error;
        log.exception(error, `Error in processing user query: ${query}`);
        return res.json({ ok: false, error: error.message });
    }
});

/**
 * Periodically check if the main server is still reachable.
 */
app.get('/reconnect-mcp-server', async (_req, res) => {
    try {
        const mcpClient = await getOrCreateClient();
        await mcpClient.ping();
        return res.json({ status: 'OK' });
    } catch (err) {
        const error = err as Error;
        return res.json({ ok: false, error: error.message });
    } finally {
        await cleanupClient();
    }
});

/**
 * GET /client-info endpoint to provide the client with necessary information
 */
app.get('/client-info', (_req, res) => {
    res.json({
        mcpUrl: runtimeSettings.mcpUrl,
        mcpTransportType: runtimeSettings.mcpTransportType,
        systemPrompt: runtimeSettings.systemPrompt,
        modelName: runtimeSettings.modelName,
        publicUrl,
        information: BASIC_INFORMATION,
    });
});

/**
 * GET /check-timeout endpoint to check if the Actor is about to timeout
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
app.post('/conversation/reset', async (_req, res) => {
    log.debug('Resetting conversation');
    conversationManager.resetConversation();
    await Actor.setValue(CONVERSATION_RECORD_NAME, conversationManager.getConversation());
    res.json({ ok: true });
});

/**
 * GET /available-tools endpoint to fetch available tools
 */
app.get('/available-tools', async (_req, res) => {
    try {
        const mcpClient = await getOrCreateClient();
        const tools = await conversationManager.updateAndGetTools(mcpClient);
        return res.json({ tools });
    } catch (err) {
        const error = err as Error;
        log.error(`Error fetching tools: ${error.message}`);
        return res.status(500).json({ error: 'Failed to fetch tools' });
    } finally {
        await cleanupClient();
    }
});

/**
 * GET /settings endpoint to retrieve current settings
 */
app.get('/settings', (_req, res) => {
    res.json(runtimeSettings);
});

/**
 * POST /settings endpoint to update settings
 */
app.post('/settings', async (req, res) => {
    try {
        const newSettings = req.body;
        if (newSettings.mcpUrl !== undefined && !newSettings.mcpUrl) {
            res.status(400).json({ success: false, error: 'MCP URL is required' });
            return;
        }
        if (newSettings.modelName !== undefined && !newSettings.modelName) {
            res.status(400).json({ success: false, error: 'Model name is required' });
            return;
        }
        runtimeSettings = {
            ...runtimeSettings,
            ...newSettings,
        };
        await conversationManager.updateClientSettings({
            systemPrompt: runtimeSettings.systemPrompt,
            modelName: runtimeSettings.modelName,
            modelMaxOutputTokens: runtimeSettings.modelMaxOutputTokens,
            maxNumberOfToolCallsPerQuery: runtimeSettings.maxNumberOfToolCallsPerQuery,
            toolCallTimeoutSec: runtimeSettings.toolCallTimeoutSec,
        });

        if (newSettings.mcpUrl !== undefined || newSettings.mcpTransportType !== undefined) {
            if (client) {
                try {
                    await client.close();
                } catch (err) {
                    log.warning('Error closing client connection:', { error: err });
                }
                client = null;
            }
            // The next API request will create a new client with updated settings
        }
        log.info(`Settings updated: ${JSON.stringify(runtimeSettings)}`);
        res.json({ success: true });
    } catch (error) {
        log.error('Error updating settings:', { error: (error instanceof Error) ? error.message : String(error) });
        res.status(500).json({ success: false, error: 'Failed to update settings' });
    }
});

/**
 * POST /settings/reset endpoint to reset settings to defaults
 */
app.post('/settings/reset', async (_req, res) => {
    try {
        runtimeSettings = {
            mcpUrl: input.mcpUrl,
            mcpTransportType: input.mcpTransportType,
            systemPrompt: input.systemPrompt,
            modelName: input.modelName,
            modelMaxOutputTokens: input.modelMaxOutputTokens,
            maxNumberOfToolCallsPerQuery: input.maxNumberOfToolCallsPerQuery,
            toolCallTimeoutSec: input.toolCallTimeoutSec,
        };
        await conversationManager.updateClientSettings({
            systemPrompt: runtimeSettings.systemPrompt,
            modelName: runtimeSettings.modelName,
            modelMaxOutputTokens: runtimeSettings.modelMaxOutputTokens,
            maxNumberOfToolCallsPerQuery: runtimeSettings.maxNumberOfToolCallsPerQuery,
            toolCallTimeoutSec: runtimeSettings.toolCallTimeoutSec,
        });

        // Close the existing client to force recreation with default settings
        if (client) {
            try {
                await client.close();
            } catch (err) {
                log.warning('Error closing client connection:', { error: err });
            }
            client = null;
        }
        res.json({ success: true });
    } catch (error) {
        log.error('Error resetting settings:', { error: (error instanceof Error) ? error.message : String(error) });
        res.status(500).json({ success: false, error: 'Failed to reset settings' });
    }
});

app.get('/conversation', (_req, res) => {
    res.json(conversationManager.getConversation());
});

app.get('*', (_req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
});

/**
 * Broadcasts an event to all connected SSE clients
 */
async function broadcastSSE(data: object) {
    log.debug('Push data into Apify dataset and persist conversation');
    await Actor.pushData(data);
    await Actor.setValue(CONVERSATION_RECORD_NAME, conversationManager.getConversation());

    log.debug(`Broadcasting message to ${browserClients.length} clients`);
    const message = `data: ${JSON.stringify(data)}\n\n`;
    browserClients.forEach((browserClient) => {
        browserClient.res.write(message);
    });
}

app.listen(PORT, async () => {
    log.info(`Serving from ${path.join(publicPath, 'index.html')}`);
    const msg = `Navigate to ${publicUrl} to interact with the chat UI.`;
    await Actor.setStatusMessage(msg);
});
