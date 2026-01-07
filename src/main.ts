/**
 * # Chatbot Server with Real-Time Tool Execution
 *
 * Server for a chatbot integrated with Apify Actors and an MCP client.
 * Processes user queries, invokes tools dynamically, and streams responses via AI SDK endpoints.
 *
 * Environment variables:
 * - `APIFY_TOKEN` - API token for Apify (when using actors-mcp-server)
 */

import path from 'path';
import { fileURLToPath } from 'url';

import { createMCPClient } from '@ai-sdk/mcp';
import { createOpenAI } from '@ai-sdk/openai';
import type { AssistantModelMessage, ModelMessage, ToolResultOutput, ToolResultPart } from '@ai-sdk/provider-utils';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ListToolsResult, LoggingMessageNotification } from '@modelcontextprotocol/sdk/types.js';
import { convertToModelMessages, stepCountIs, streamText } from 'ai';
import { Actor } from 'apify';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';

import {
    createSchemaModelsHandler,
    createSettingsHandlers,
    createToolsHandlers,
} from './apiHandlers.js';
import { createClient } from './clientFactory.js';
import { BASIC_INFORMATION, CONVERSATION_RECORD_NAME } from './const.js';
import {
    coerceStoredConversation,
    modelMessagesToLegacyConversation,
    toolResultToLegacyBlock,
} from './conversationUtils.js';
import { Counter } from './counter.js';
import { processInput } from './input.js';
import { log } from './logger.js';
import type { Input } from './types.js';
import inputSchema from '../.actor/input_schema.json' with { type: 'json' };

await Actor.init();

const STANDBY_MODE = Actor.getEnv().metaOrigin === 'STANDBY';
const ACTOR_IS_AT_HOME = Actor.isAtHome();
let HOST: string | undefined;
let PORT: string | undefined;

if (ACTOR_IS_AT_HOME) {
    HOST = STANDBY_MODE ? process.env.ACTOR_STANDBY_URL : process.env.ACTOR_WEB_SERVER_URL;
    PORT = STANDBY_MODE ? process.env.ACTOR_STANDBY_PORT : process.env.ACTOR_WEB_SERVER_PORT;
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

const defaultRuntimeSettings = {
    mcpUrl: input.mcpUrl,
    mcpTransportType: input.mcpTransportType,
    systemPrompt: input.systemPrompt,
    modelName: input.modelName,
    modelMaxOutputTokens: input.modelMaxOutputTokens,
    maxNumberOfToolCallsPerQuery: input.maxNumberOfToolCallsPerQuery,
    toolCallTimeoutSec: input.toolCallTimeoutSec,
};
let runtimeSettings = { ...defaultRuntimeSettings };

const OPENROUTER_BASE_URL = 'https://openrouter.apify.actor/api/v1';
const OPENROUTER_DEFAULT_MODEL = 'anthropic/claude-haiku-4.5';
const OPENROUTER_API_KEY_PLACEHOLDER = 'no-key-required-but-must-not-be-empty';

const resolveOpenRouterModel = (modelName?: string) => {
    if (modelName && modelName.includes('/')) {
        return modelName;
    }
    if (modelName) {
        log.warning(`Model "${modelName}" is not an OpenRouter model id. Falling back to ${OPENROUTER_DEFAULT_MODEL}.`);
    }
    return OPENROUTER_DEFAULT_MODEL;
};

const getOpenRouterProvider = () => {
    const token = process.env.APIFY_TOKEN;
    if (!token) {
        throw new Error('Missing APIFY_TOKEN for OpenRouter proxy.');
    }
    return createOpenAI({
        baseURL: OPENROUTER_BASE_URL,
        apiKey: OPENROUTER_API_KEY_PLACEHOLDER,
        headers: {
            Authorization: `Bearer ${token}`,
        },
        name: 'openrouter',
    });
};

let toolsCache: { name: string; description?: string; input_schema: unknown; title?: string }[] = [];
let client: Client | null = null;

/**
 * NOTE: We intentionally keep two MCP clients:
 * - AI SDK client for tool execution during LLM streaming.
 * - MCP SDK client for notifications (tool list changes, logging).
 *
 * We wanted to use only the AI SDK MCP client, but it does not support
 * notifications (sadly), so we keep the MCP SDK client for live updates and
 * cache refresh.
 *
 * Example usage:
 * ```ts
 * const mcpClient = await createAiSdkMcpClient();
 * const tools = await mcpClient.tools();
 * const result = streamText({ model, messages, tools });
 * await mcpClient.close();
 * ```
 */
const createAiSdkMcpClient = async () => {
    const transportType = runtimeSettings.mcpTransportType === 'sse' ? 'sse' : 'http';
    return createMCPClient({
        transport: {
            type: transportType,
            url: runtimeSettings.mcpUrl,
            headers: input.headers,
        },
        name: 'apify-mcp-client',
        version: '1.0.0',
    });
};

const {
    getSettings,
    updateSettings,
    resetSettings,
} = createSettingsHandlers({
    getRuntimeSettings: () => runtimeSettings,
    setRuntimeSettings: (next) => {
        runtimeSettings = next;
    },
    defaultSettings: defaultRuntimeSettings,
    onSettingsUpdated: async (next, patch) => {
        if (patch.mcpUrl !== undefined || patch.mcpTransportType !== undefined) {
            if (client) {
                try {
                    await client.close();
                } catch (err) {
                    log.warning('Error closing client connection:', { error: err });
                }
                client = null;
            }
        }
        log.info(`Settings updated: ${JSON.stringify(next)}`);
    },
});

const {
    availableTools,
    apiTools,
} = createToolsHandlers({
    getToolsCache: () => toolsCache,
    ensureToolsCache: async () => {
        if (toolsCache.length === 0) {
            await getOrCreateClient();
        }
    },
    onError: (error) => {
        log.error('Error fetching tools', { error: error.message });
    },
});

const schemaModelsHandler = createSchemaModelsHandler(
    inputSchema.properties.modelName as { enum?: string[]; enumTitles?: string[] },
);

const app = express();
app.use(express.json());
app.use(cors());

// Serve your public folder (where index.html is located)
const filename = fileURLToPath(import.meta.url);
const publicPath = path.join(path.dirname(filename), 'public');
const publicUrl = ACTOR_IS_AT_HOME ? HOST : `${HOST}:${PORT}`;
app.use(express.static(publicPath));

const persistedConversationRaw = await Actor.getValue(CONVERSATION_RECORD_NAME);
let modelConversation: ModelMessage[] = coerceStoredConversation(persistedConversationRaw);
const conversationCounter = new Counter(modelMessagesToLegacyConversation(modelConversation).length);

const persistConversation = async () => {
    await Actor.setValue(CONVERSATION_RECORD_NAME, modelConversation);
};

Actor.on('migrating', async () => {
    log.debug(`Migrating ... persisting conversation.`);
    await persistConversation();
});

const updateToolsCache = async (listTools: ListToolsResult) => {
    toolsCache = listTools.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
        title: tool.annotations?.title,
    }));
};

const handleNotification = (notification: LoggingMessageNotification) => {
    log.debug(`Notification received: ${notification.params.level} - ${notification.params.data}`);
};

/**
 * Helper function to create or get existing MCP client
 * @returns Client instance or throws error
 */
async function getOrCreateClient(): Promise<Client> {
    log.debug('Getting or creating MCP client');
    if (!client) {
        log.debug('Creating new MCP client');
        try {
            client = await createClient(
                runtimeSettings.mcpUrl,
                runtimeSettings.mcpTransportType,
                input.headers,
                async (tools) => updateToolsCache(tools),
                (notification) => handleNotification(notification),
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
    if (input.mcpTransportType === 'http' && client) {
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

    let mcpClient: Awaited<ReturnType<typeof createAiSdkMcpClient>> | null = null;
    try {
        await Actor.pushData({ role: 'user', content: query });
        modelConversation.push({ role: 'user', content: query });

        const openrouter = getOpenRouterProvider();
        mcpClient = await createAiSdkMcpClient();
        const tools = await mcpClient.tools();
        const modelId = resolveOpenRouterModel(runtimeSettings.modelName);

        const result = streamText({
            model: openrouter.chat(modelId),
            messages: modelConversation,
            system: runtimeSettings.systemPrompt,
            maxOutputTokens: runtimeSettings.modelMaxOutputTokens,
            tools,
            stopWhen: stepCountIs(runtimeSettings.maxNumberOfToolCallsPerQuery),
        });

        const assistantBefore: AssistantModelMessage[] = [];
        const assistantAfter: AssistantModelMessage[] = [];
        const toolResults: ToolResultPart[] = [];
        let toolResultsSeen = false;
        let pendingTextForSse = '';
        let currentAssistantText = '';
        let currentToolCalls: { toolCallId: string; toolName: string; input: unknown }[] = [];

        const recordEvent = async (data: object) => {
            await Actor.pushData(data);
        };

        const emitTextIfAny = async () => {
            if (!pendingTextForSse) {
                return;
            }
            const key = conversationCounter.increment();
            await recordEvent({
                role: 'assistant',
                content: pendingTextForSse,
                key,
            });
            pendingTextForSse = '';
        };

        const finalizeAssistantMessage = () => {
            if (!currentAssistantText && currentToolCalls.length === 0) {
                return;
            }
            if (currentToolCalls.length === 0) {
                const message: AssistantModelMessage = { role: 'assistant', content: currentAssistantText };
                if (toolResultsSeen) {
                    assistantAfter.push(message);
                } else {
                    assistantBefore.push(message);
                }
            } else {
                const contentParts: (
                    | { type: 'text'; text: string }
                    | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
                )[] = [];
                if (currentAssistantText) {
                    contentParts.push({ type: 'text', text: currentAssistantText });
                }
                contentParts.push(
                    ...currentToolCalls.map((call) => ({
                        type: 'tool-call' as const,
                        toolCallId: call.toolCallId,
                        toolName: call.toolName,
                        input: call.input,
                    })),
                );
                const message: AssistantModelMessage = { role: 'assistant', content: contentParts };
                if (toolResultsSeen) {
                    assistantAfter.push(message);
                } else {
                    assistantBefore.push(message);
                }
            }
            currentAssistantText = '';
            currentToolCalls = [];
        };

        for await (const part of result.fullStream) {
            if (part.type === 'text-delta') {
                currentAssistantText += part.text;
                pendingTextForSse += part.text;
                continue;
            }
            if (part.type === 'tool-call') {
                await emitTextIfAny();
                currentToolCalls.push({
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    input: part.input,
                });
                const key = conversationCounter.increment();
                await recordEvent({
                    role: 'assistant',
                    content: [{
                        type: 'tool_use',
                        id: part.toolCallId,
                        name: part.toolName,
                        input: part.input,
                    }],
                    key,
                });
                continue;
            }
            if (part.type === 'tool-result') {
                if (!toolResultsSeen) {
                    finalizeAssistantMessage();
                    toolResultsSeen = true;
                }
                const output = part.output as ToolResultOutput;
                const legacyBlock = toolResultToLegacyBlock(part.toolCallId, output);
                toolResults.push({
                    type: 'tool-result',
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    output,
                });
                const key = conversationCounter.increment();
                await recordEvent({
                    role: 'user',
                    content: [legacyBlock],
                    key,
                });
                continue;
            }
            if (part.type === 'tool-error') {
                if (!toolResultsSeen) {
                    finalizeAssistantMessage();
                    toolResultsSeen = true;
                }
                const legacyBlock = toolResultToLegacyBlock(part.toolCallId, {
                    type: 'error-text',
                    value: part.error instanceof Error ? part.error.message : String(part.error),
                });
                toolResults.push({
                    type: 'tool-result',
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    output: {
                        type: 'error-text',
                        value: part.error instanceof Error ? part.error.message : String(part.error),
                    },
                });
                const key = conversationCounter.increment();
                await recordEvent({
                    role: 'user',
                    content: [legacyBlock],
                    key,
                });
            }
        }

        await emitTextIfAny();
        finalizeAssistantMessage();

        if (assistantBefore.length > 0) {
            modelConversation.push(...assistantBefore);
        }
        if (toolResults.length > 0) {
            modelConversation.push({ role: 'tool', content: toolResults });
        }
        if (assistantAfter.length > 0) {
            modelConversation.push(...assistantAfter);
        }
        await persistConversation();

        await recordEvent({ role: 'system', content: '', finished: true });
        return res.json({ ok: true });
    } catch (err) {
        const error = err as Error;
        log.exception(error, `Error in processing user query: ${query}`);
        modelConversation.push({ role: 'assistant', content: error.message });
        await persistConversation();
        // Send finished flag with error
        await Actor.pushData({ role: 'system', content: error.message, finished: true, error: true });
        return res.json({ ok: false, error: error.message });
    } finally {
        if (mcpClient) {
            await mcpClient.close();
        }
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
    }
});

/**
 * GET /mcp/health endpoint to verify MCP connectivity for the new UI.
 */
app.get('/mcp/health', async (_req, res) => {
    try {
        const mcpClient = await getOrCreateClient();
        await mcpClient.ping();
        return res.json({ ok: true });
    } catch (err) {
        const error = err as Error;
        return res.json({ ok: false, error: error.message });
    }
});

/**
 * GET /api/tools endpoint for the new UI tool list.
 */
app.get('/api/tools', async (_req, res) => {
    return apiTools(_req, res, () => {});
});

/**
 * POST /api/chat endpoint for the new AI SDK chat flow.
 */
app.post('/api/chat', async (req, res) => {
    const { messages } = req.body ?? {};
    if (!Array.isArray(messages)) {
        res.status(400).json({ error: 'Missing "messages" array.' });
        return;
    }

    let mcpClient: Awaited<ReturnType<typeof createAiSdkMcpClient>> | null = null;
    let closeCalled = false;
    const closeClient = async () => {
        if (mcpClient && !closeCalled) {
            closeCalled = true;
            await mcpClient.close();
        }
    };

    try {
        const openrouter = getOpenRouterProvider();
        mcpClient = await createAiSdkMcpClient();
        const tools = await mcpClient.tools();
        const modelId = resolveOpenRouterModel(runtimeSettings.modelName);

        const modelMessages = await convertToModelMessages(messages);
        const result = streamText({
            model: openrouter.chat(modelId),
            messages: modelMessages,
            system: runtimeSettings.systemPrompt,
            maxOutputTokens: runtimeSettings.modelMaxOutputTokens,
            tools,
            stopWhen: stepCountIs(runtimeSettings.maxNumberOfToolCallsPerQuery),
            onFinish: async () => {
                await closeClient();
                await closeClient();
            },
            onError: async (error) => {
                log.error('AI SDK chat error', { error: (error instanceof Error) ? error.message : String(error) });
                await closeClient();
            },
        });

        res.on('close', () => {
            closeClient().catch((error) => {
                log.error('Error closing MCP client', { error: error instanceof Error ? error.message : String(error) });
            });
        });

        result.pipeTextStreamToResponse(res);
    } catch (err) {
        const error = err as Error;
        log.error('Error in /api/chat', { error: error.message, stack: error.stack });
        await closeClient();
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
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
    modelConversation = [];
    await persistConversation();
    res.json({ ok: true });
});

/**
 * GET /available-tools endpoint to fetch available tools
 */
app.get('/available-tools', async (_req, res) => {
    return availableTools(_req, res, () => {});
});

/**
 * GET /settings endpoint to retrieve current settings
 */
app.get('/settings', (_req, res) => {
    return getSettings(_req, res, () => {});
});

/**
 * GET /schema/models endpoint to retrieve available model options from input schema
 */
app.get('/schema/models', (_req, res) => {
    return schemaModelsHandler(_req, res, () => {});
});

/**
 * POST /settings endpoint to update settings
 */
app.post('/settings', async (req, res) => {
    return updateSettings(req, res, () => {});
});

/**
 * POST /settings/reset endpoint to reset settings to defaults
 */
app.post('/settings/reset', async (_req, res) => {
    return resetSettings(_req, res, () => {});
});

app.get('/conversation', (_req, res) => {
    res.json(modelMessagesToLegacyConversation(modelConversation));
});

app.get('*', (_req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
});

app.listen(PORT, async () => {
    log.info(`Serving from ${path.join(publicPath, 'index.html')}`);
    const msg = `Navigate to ${publicUrl} to interact with the chat UI.`;
    await Actor.setStatusMessage(msg);
    try {
        await getOrCreateClient();
    } catch (error) {
        log.warning('Failed to initialize MCP client on startup', { error });
    }
});

// Fix Ctrl+C for npm run start
process.on('SIGINT', async () => {
    log.info('Received SIGINT. Cleaning up and exiting...');
    await cleanupClient();
    await Actor.exit('SIGINT received');
});
