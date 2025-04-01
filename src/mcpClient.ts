/**
 * Create an MCP client that connects to the server using SSE transport
 *
 */

import { Anthropic } from '@anthropic-ai/sdk';
import type { Message, MessageParam, ContentBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { CallToolResultSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { log } from 'apify';
import { EventSource } from 'eventsource';

import type { Tool, TokenCharger } from './types.js';

if (typeof globalThis.EventSource === 'undefined') {
    globalThis.EventSource = EventSource as unknown as typeof globalThis.EventSource;
}

export class MCPClient {
    private conversation: MessageParam[] = [];
    private _isConnected = false;
    private anthropic: Anthropic;
    private readonly serverUrl: string;
    private readonly customHeaders: Record<string, string> | null;
    private readonly systemPrompt: string;
    private readonly modelName: string;
    private readonly modelMaxOutputTokens: number;
    private readonly maxNumberOfToolCallsPerQuery: number;
    private readonly toolCallTimeoutSec: number;
    private readonly tokenCharger: TokenCharger | null;
    private client = new Client(
        { name: 'example-client', version: '0.1.0' },
        { capabilities: {} },
    );

    private tools: Tool[] = [];

    constructor(
        serverUrl: string,
        headers: Record<string, string> | null,
        systemPrompt: string,
        modelName: string,
        apiKey: string,
        modelMaxOutputTokens: number,
        maxNumberOfToolCallsPerQuery: number,
        toolCallTimeoutSec: number,
        tokenCharger: TokenCharger | null = null,
    ) {
        this.serverUrl = serverUrl;
        this.systemPrompt = systemPrompt;
        this.customHeaders = headers;
        this.modelName = modelName;
        this.modelMaxOutputTokens = modelMaxOutputTokens;
        this.maxNumberOfToolCallsPerQuery = maxNumberOfToolCallsPerQuery;
        this.toolCallTimeoutSec = toolCallTimeoutSec;
        this.tokenCharger = tokenCharger;
        this.anthropic = new Anthropic({ apiKey });
    }

    /**
     * Start the server using node and provided server script path.
     * Connect to the server using stdio transport and list available tools.
     */
    async connectToServer() {
        if (this._isConnected) return;
        const { customHeaders } = this;
        const transport = new SSEClientTransport(
            new URL(this.serverUrl),
            {
                requestInit: { headers: this.customHeaders || undefined },
                eventSourceInit: {
                    // The EventSource package augments EventSourceInit with a "fetch" parameter.
                    // You can use this to set additional headers on the outgoing request.
                    // Based on this example: https://github.com/modelcontextprotocol/typescript-sdk/issues/118
                    async fetch(input: Request | URL | string, init?: RequestInit) {
                        const headers = new Headers({ ...(init?.headers || {}), ...customHeaders });
                        return fetch(input, { ...init, headers });
                    },
                    // We have to cast to "any" to use it, since it's non-standard
                } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
            },
        );
        await this.client.connect(transport);
        await this.updateTools();
        await this.setNotifications();
    }

    async setNotifications() {
        this.client.setNotificationHandler(
            ToolListChangedNotificationSchema,
            async () => {
                log.debug('Received notification that tools list changed, refreshing...');
                await this.updateTools();
            },
        );
    }

    async isConnected() {
        try {
            await this.client.ping();
            this._isConnected = true;
            return 'OK';
        } catch (error) {
            this._isConnected = false;
            if (error instanceof Error) {
                return error.message;
            }
            return String(error);
        }
    }

    getConversation() {
        return this.conversation;
    }

    resetConversation() {
        this.conversation = [];
    }

    async updateTools() {
        const response = await this.client.listTools();
        this.tools = response.tools.map((x) => ({
            name: x.name,
            description: x.description,
            input_schema: x.inputSchema,
        }));
        log.debug(`Connected to server with tools: ${this.tools.map((x) => x.name)}`);
    }

    private async createMessageWithRetry(
        messages: MessageParam[],
        maxRetries = 3,
        retryDelayMs = 2000, // 2 seconds
    ): Promise<Message> {
        let lastError: Error | null = null;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const response = await this.anthropic.messages.create({
                    model: this.modelName,
                    max_tokens: this.modelMaxOutputTokens,
                    messages,
                    system: this.systemPrompt,
                    tools: this.tools as any[], // eslint-disable-line @typescript-eslint/no-explicit-any
                });
                if (this.tokenCharger && response.usage) {
                    const inputTokens = response.usage.input_tokens ?? 0;
                    const outputTokens = response.usage.output_tokens ?? 0;
                    await this.tokenCharger.chargeTokens(inputTokens, outputTokens, this.modelName);
                }
                return response;
            } catch (error) {
                lastError = error as Error;
                if (error instanceof Error) {
                    if (error.message.includes('429') || error.message.includes('529')) {
                        if (attempt < maxRetries) {
                            const delay = attempt * retryDelayMs;
                            const errorType = error.message.includes('429') ? 'Rate limit' : 'Server overload';
                            log.debug(`${errorType} hit, attempt ${attempt}/${maxRetries}. Retrying in ${delay / 1000} seconds...`);
                            await new Promise((resolve) => {
                                setTimeout(resolve, delay);
                            });
                            continue;
                        } else {
                            const errorType = error.message.includes('429') ? 'Rate limit' : 'Server overload';
                            const errorMsg = errorType === 'Rate limit'
                                ? `Rate limit exceeded after ${maxRetries} attempts. Please try again in a few minutes or consider switching to a different model`
                                : 'Server is currently experiencing high load. Please try again in a few moments or consider switching to a different model.';
                            throw new Error(errorMsg);
                        }
                    }
                    // Handle tool_use without tool_result blocks error
                    if (error.message.includes('tool_use') && error.message.includes('without tool_result blocks')) {
                        log.debug('Found tool_use without corresponding tool_result blocks, removing problematic message and retrying...');
                        // Find the message with the specific tool_use ID
                        const toolUseId = error.message.match(/toolu_[A-Za-z0-9]+/)?.[0];
                        if (toolUseId) {
                            const problematicIndex = messages.findIndex((msg) => {
                                if (typeof msg.content === 'string') return false;
                                return msg.content.some((block) => block.type === 'tool_use' && block.id === toolUseId);
                            });

                            if (problematicIndex !== -1) {
                                messages.splice(problematicIndex, 1);
                                continue;
                            }
                        }
                    }
                }
                // For other errors, throw immediately
                throw error;
            }
        }
        throw lastError;
    }

    async handleLLMResponse(response: Message, sseEmit: (role: string, content: string | ContentBlockParam[]) => void, toolCallCount = 0) {
        for (const block of response.content) {
            if (block.type === 'text') {
                this.conversation.push({ role: 'assistant', content: block.text || '' });
                sseEmit('assistant', block.text || '');
            } else if (block.type === 'tool_use') {
                if (toolCallCount > this.maxNumberOfToolCallsPerQuery) {
                    const msg = `Too many tool calls in a single turn! This has been implemented to prevent infinite loops.
                        Limit is ${this.maxNumberOfToolCallsPerQuery}.
                        You can increase the limit by setting the "maxNumberOfToolCallsPerQuery" parameter.`;
                    this.conversation.push({ role: 'assistant', content: msg });
                    sseEmit('assistant', msg);
                    const finalResponse = await this.createMessageWithRetry(this.conversation);
                    this.conversation.push({ role: 'assistant', content: finalResponse.content || '' });
                    sseEmit('assistant', finalResponse.content || '');
                    return;
                }
                const msgAssistant = {
                    role: 'assistant' as const,
                    content: [{ id: block.id, input: block.input, name: block.name, type: 'tool_use' as const }],
                };
                this.conversation.push(msgAssistant);
                sseEmit(msgAssistant.role, msgAssistant.content);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const params = { name: block.name, arguments: block.input as any };
                log.debug(`[internal] Calling tool (count: ${toolCallCount}): ${JSON.stringify(params)}`);
                // Create the tool result message structure upfront
                const msgUser = {
                    role: 'user' as const,
                    content: [{
                        tool_use_id: block.id,
                        type: 'tool_result' as const,
                        content: '',
                        is_error: false,
                    }],
                };
                try {
                    const results = await this.client.callTool(params, CallToolResultSchema, { timeout: this.toolCallTimeoutSec * 1000 });
                    if (results.content instanceof Array && results.content.length !== 0) {
                        const text = results.content.map((x) => x.text);
                        msgUser.content[0].content = text.join('\n\n');
                    } else {
                        msgUser.content[0].content = `No results retrieved from ${params.name}`;
                        msgUser.content[0].is_error = true;
                    }
                } catch (error) {
                    log.error(`Error when calling tool ${params.name}: ${error}`);
                    msgUser.content[0].content = `Error when calling tool ${params.name}, error: ${error}`;
                    msgUser.content[0].is_error = true;
                }
                // Always add the tool result to conversation and emit it
                this.conversation.push(msgUser);
                sseEmit(msgUser.role, msgUser.content);
                // Get next response from Claude
                log.debug('[internal] Get model response from tool result');
                const nextResponse: Message = await this.createMessageWithRetry(this.conversation);
                log.debug('[internal] Received response from model');
                await this.handleLLMResponse(nextResponse, sseEmit, toolCallCount + 1);
                log.debug('[internal] Finished processing tool result');
            }
        }
    }

    /**
     * Process a user query:
     * 1) Use Anthropic to generate a response (which may contain "tool_use").
     * 2) If "tool_use" is present, call the main actor's tool via `this.mcpClient.callTool()`.
     * 3) Return or yield partial results so we can SSE them to the browser.
     */
    async processUserQuery(query: string, sseEmit: (role: string, content: string | ContentBlockParam[]) => void) {
        await this.connectToServer(); // ensure connected
        log.debug(`[internal] User query: ${JSON.stringify(query)}`);
        this.conversation.push({ role: 'user', content: query });

        try {
            const response = await this.createMessageWithRetry(this.conversation);
            log.debug(`[internal] Received response: ${JSON.stringify(response.content)}`);
            log.debug(`[internal] Token count: ${JSON.stringify(response.usage)}`);
            await this.handleLLMResponse(response, sseEmit);
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.conversation.push({ role: 'assistant', content: errorMsg });
            sseEmit('assistant', errorMsg);
            throw new Error(errorMsg);
        }
    }
}
