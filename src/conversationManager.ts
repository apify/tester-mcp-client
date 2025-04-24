/**
 * Create an MCP client that connects to the server using SSE transport
 *
 */

import { Anthropic } from '@anthropic-ai/sdk';
import type { Message, MessageParam, ContentBlockParam } from '@anthropic-ai/sdk/resources/messages';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ListToolsResult, Notification } from '@modelcontextprotocol/sdk/types.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { log } from 'apify';
import { EventSource } from 'eventsource';

import type { Tool, TokenCharger } from './types.js';
import { pruneConversation } from './utils.js';

if (typeof globalThis.EventSource === 'undefined') {
    globalThis.EventSource = EventSource as unknown as typeof globalThis.EventSource;
}

export class ConversationManager {
    private conversation: MessageParam[] = [];
    private anthropic: Anthropic;
    private systemPrompt: string;
    private modelName: string;
    private modelMaxOutputTokens: number;
    private maxNumberOfToolCallsPerQuery: number;
    private toolCallTimeoutSec: number;
    private readonly tokenCharger: TokenCharger | null;
    private tools: Tool[] = [];

    constructor(
        systemPrompt: string,
        modelName: string,
        apiKey: string,
        modelMaxOutputTokens: number,
        maxNumberOfToolCallsPerQuery: number,
        toolCallTimeoutSec: number,
        tokenCharger: TokenCharger | null = null,
        persistedConversation: MessageParam[] = [],
    ) {
        this.systemPrompt = systemPrompt;
        this.modelName = modelName;
        this.modelMaxOutputTokens = modelMaxOutputTokens;
        this.maxNumberOfToolCallsPerQuery = maxNumberOfToolCallsPerQuery;
        this.toolCallTimeoutSec = toolCallTimeoutSec;
        this.tokenCharger = tokenCharger;
        this.anthropic = new Anthropic({ apiKey });
        this.conversation = [...persistedConversation];
    }

    getConversation(): MessageParam[] {
        return this.conversation;
    }

    resetConversation() {
        this.conversation = [];
    }

    async handleToolUpdate(listTools: ListToolsResult) {
        this.tools = listTools.tools.map((x) => ({
            name: x.name,
            description: x.description,
            input_schema: x.inputSchema,
        }));
        log.debug(`Connected to server with tools: ${this.tools.map((x) => x.name)}`);
    }

    async updateAndGetTools(mcpClient: Client) {
        const tools = await mcpClient.listTools();
        await this.handleToolUpdate(tools);
        return this.tools;
    }

    /**
     * Update client settings with new values
     */
    async updateClientSettings(settings: {
        systemPrompt?: string;
        modelName?: string;
        modelMaxOutputTokens?: number;
        maxNumberOfToolCallsPerQuery?: number;
        toolCallTimeoutSec?: number;
    }): Promise<boolean> {
        if (settings.systemPrompt !== undefined) this.systemPrompt = settings.systemPrompt;
        if (settings.modelName !== undefined && settings.modelName !== this.modelName) this.modelName = settings.modelName;
        if (settings.modelMaxOutputTokens !== undefined) this.modelMaxOutputTokens = settings.modelMaxOutputTokens;
        if (settings.maxNumberOfToolCallsPerQuery !== undefined) this.maxNumberOfToolCallsPerQuery = settings.maxNumberOfToolCallsPerQuery;
        if (settings.toolCallTimeoutSec !== undefined) this.toolCallTimeoutSec = settings.toolCallTimeoutSec;

        return true;
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
                    // TODO if we are not careful with slice, we can remove message and get this error
                    // 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.0.content.0: unexpected tool_use_id found in tool_result
                    // messages: messages.slice(-MAX_HISTORY_CONVERSATIONS),
                    messages: pruneConversation(messages),
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

    async handleLLMResponse(client: Client, response: Message, sseEmit: (role: string, content: string | ContentBlockParam[]) => void, toolCallCount = 0) {
        for (const block of response.content) {
            if (block.type === 'text') {
                this.conversation.push({ role: 'assistant', content: block.text || '' });
                sseEmit('assistant', block.text || '');
            } else if (block.type === 'tool_use') {
                if (toolCallCount >= this.maxNumberOfToolCallsPerQuery) {
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
                    const results = await client.callTool(params, CallToolResultSchema, { timeout: this.toolCallTimeoutSec * 1000 });
                    if (results.content instanceof Array && results.content.length !== 0) {
                        const text = results.content.map((x) => x.text ?? x.data);
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
                // Always add the tool result to the conversation and emit it
                this.conversation.push(msgUser);
                sseEmit(msgUser.role, msgUser.content);
                // Get next response from Claude
                log.debug('[internal] Get model response from tool result');
                const nextResponse: Message = await this.createMessageWithRetry(this.conversation);
                log.debug('[internal] Received response from model');
                await this.handleLLMResponse(client, nextResponse, sseEmit, toolCallCount + 1);
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
    async processUserQuery(client: Client, query: string, sseEmit: (role: string, content: string | ContentBlockParam[]) => void) {
        log.debug(`[internal] Call LLM with user query: ${JSON.stringify(query)}`);
        this.conversation.push({ role: 'user', content: query });

        try {
            const response = await this.createMessageWithRetry(this.conversation);
            log.debug(`[internal] Received response: ${JSON.stringify(response.content)}`);
            log.debug(`[internal] Token count: ${JSON.stringify(response.usage)}`);
            await this.handleLLMResponse(client, response, sseEmit);
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.conversation.push({ role: 'assistant', content: errorMsg });
            sseEmit('assistant', errorMsg);
            throw new Error(errorMsg);
        }
    }

    handleNotification(notification: Notification) {
        // Implement logic to handle the notification
        log.info(`Handling notification: ${JSON.stringify(notification)}`);
        // You can update the conversation or perform other actions based on the notification
    }
}
