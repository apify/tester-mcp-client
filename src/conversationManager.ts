/**
 * Create an MCP client that connects to the server using SSE transport
 *
 */

import { Anthropic } from '@anthropic-ai/sdk';
import type { ContentBlockParam, Message, MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ListToolsResult, Notification } from '@modelcontextprotocol/sdk/types.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { log } from 'apify';
import { EventSource } from 'eventsource';

import type { TokenCharger, Tool } from './types.js';
import { pruneAndFixConversation } from './utils.js';

if (typeof globalThis.EventSource === 'undefined') {
    globalThis.EventSource = EventSource as unknown as typeof globalThis.EventSource;
}

// Define a default, can be overridden in constructor
const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;
// Define a safety margin to avoid edge cases
const CONTEXT_TOKEN_SAFETY_MARGIN = 0.99;

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
    private readonly maxContextTokens: number;

    constructor(
        systemPrompt: string,
        modelName: string,
        apiKey: string,
        modelMaxOutputTokens: number,
        maxNumberOfToolCallsPerQuery: number,
        toolCallTimeoutSec: number,
        tokenCharger: TokenCharger | null = null,
        persistedConversation: MessageParam[] = [],
        maxContextTokens: number = DEFAULT_MAX_CONTEXT_TOKENS,
    ) {
        this.systemPrompt = systemPrompt;
        this.modelName = modelName;
        this.modelMaxOutputTokens = modelMaxOutputTokens;
        this.maxNumberOfToolCallsPerQuery = maxNumberOfToolCallsPerQuery;
        this.toolCallTimeoutSec = toolCallTimeoutSec;
        this.tokenCharger = tokenCharger;
        this.anthropic = new Anthropic({ apiKey });
        this.conversation = [...persistedConversation];
        this.maxContextTokens = Math.floor(maxContextTokens * CONTEXT_TOKEN_SAFETY_MARGIN);
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

    // /**
    //  * Adds fake tool_result messages for tool_use messages that don't have a corresponding tool_result message.
    //  * @returns
    //  */
    // private fixToolResult() {
    //     // Storing both in case the messages are in the wrong order
    //     const toolUseIDs = new Set<string>();
    //     const toolResultIDs = new Set<string>();
    //
    //     for (let m = 0; m < this.conversation.length; m++) {
    //         const message = this.conversation[m];
    //
    //         if (typeof message.content === 'string') continue;
    //
    //         // Handle messages with content blocks
    //         const contentBlocks = message.content as ContentBlockParam[];
    //         for (let i = 0; i < contentBlocks.length; i++) {
    //             const block = contentBlocks[i];
    //             if (block.type === 'tool_use') {
    //                 toolUseIDs.add(block.id);
    //             } else if (block.type === 'tool_result') {
    //                 toolResultIDs.add(block.tool_use_id);
    //             }
    //         }
    //     }
    //     const toolUseIDsWithoutResult = Array.from(toolUseIDs).filter((id) => !toolResultIDs.has(id));
    //
    //     if (toolUseIDsWithoutResult.length < 1) {
    //         return;
    //     }
    //
    //     const fixedConversation: MessageParam[] = [];
    //     for (let m = 0; m < this.conversation.length; m++) {
    //         const message = this.conversation[m];
    //
    //         fixedConversation.push(message);
    //         // Handle messages with content blocks
    //         if (typeof message.content === 'string') continue;
    //
    //         const contentBlocks = message.content as ContentBlockParam[];
    //         for (let i = 0; i < contentBlocks.length; i++) {
    //             const block = contentBlocks[i];
    //             if (block.type === 'tool_use' && toolUseIDsWithoutResult.includes(block.id)) {
    //                 log.debug(`Adding fake tool_result message for tool_use with ID: ${block.id}`);
    //                 fixedConversation.push({
    //                     role: 'user',
    //                     content: [
    //                         {
    //                             type: 'tool_result',
    //                             tool_use_id: block.id,
    //                             content: '[Tool use without result - most likely tool failed or response was too large to be sent to LLM]',
    //                         },
    //                     ],
    //                 });
    //             }
    //         }
    //     }
    //     this.conversation = fixedConversation;
    // }

    /**
     * Count the number of tokens in the conversation history using Anthropic's API.
     * @returns The number of tokens in the conversation.
     */
    private async countTokens(messages: MessageParam[]): Promise<number> {
        if (messages.length === 0) {
            return 0;
        }
        try {
            const response = await this.anthropic.messages.countTokens({
                model: this.modelName,
                messages,
                system: this.systemPrompt,
                tools: this.tools as any[], // eslint-disable-line @typescript-eslint/no-explicit-any
            });
            return response.input_tokens ?? 0;
        } catch (error) {
            log.warning(`Error counting tokens: ${error instanceof Error ? error.message : String(error)}`);
            return Infinity;
        }
    }

    /**
     * Ensures the conversation history does not exceed the maximum token limit.
     * Removes oldest messages if necessary.
     */
    private async ensureContextWindowLimit(): Promise<void> {
        if (this.conversation.length <= 1) {
            return;
        }

        let currentTokens = await this.countTokens(this.conversation);
        if (currentTokens <= this.maxContextTokens) {
            log.info(`[Context truncation] Current token count (${currentTokens}) is within limit (${this.maxContextTokens}). No truncation needed.`);
            return;
        }

        log.info(`[Context truncation] Current token count (${currentTokens}) exceeds limit (${this.maxContextTokens}). Truncating conversation...`);
        const initialMessagesCount = this.conversation.length;

        while (currentTokens > this.maxContextTokens && this.conversation.length > 1) {
            try {
                this.conversation.shift(); // Remove the oldest message
                this.conversation = pruneAndFixConversation(this.conversation);
                // if the oldest message is a tool result, remove the corresponding tool message as well
                if (this.conversation.length > 1) {
                    const firstMessage = this.conversation[0];
                    if (Array.isArray(firstMessage.content) && firstMessage.content[0]?.type === 'tool_result') {
                        this.conversation.shift();
                    }
                }
                currentTokens = await this.countTokens(this.conversation);
                // Wait for a short period to avoid hitting the API too quickly
                await new Promise<void>((resolve) => {
                    setTimeout(() => resolve(), 5);
                });
            } catch (error) {
                log.error(`Error during context window limit check: ${error instanceof Error ? error.message : String(error)}`);
                break;
            }
        }
        log.info(`[Context truncation] Finished. Removed ${initialMessagesCount - this.conversation.length} messages. `
                  + `Current token count: ${currentTokens}. Messages remaining: ${this.conversation.length}.`);
        // This is here mostly like a safety net, but it should not be needed
        this.conversation = pruneAndFixConversation(this.conversation);
    }

    private async createMessageWithRetry(
        maxRetries = 3,
        retryDelayMs = 2000, // 2 seconds
    ): Promise<Message> {
        // Check context window before API call
        // TODO pruneAndFix could be a class function, I had it there but I had to revert because of images size
        this.conversation = pruneAndFixConversation(this.conversation);
        await this.ensureContextWindowLimit();

        let lastError: Error | null = null;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                log.debug(`Making API call with ${this.conversation.length} messages`);
                const response = await this.anthropic.messages.create({
                    model: this.modelName,
                    max_tokens: this.modelMaxOutputTokens,
                    messages: this.conversation,
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
                    // Log conversation state for debugging
                    if (error.message.includes('tool_use_id') || error.message.includes('tool_result') || error.message.includes('at least one message')) {
                        const conversationDebug = this.conversation.map((msg, index) => ({
                            index,
                            role: msg.role,
                            contentTypes: Array.isArray(msg.content) 
                                ? msg.content.map(block => block.type) 
                                : 'string',
                            contentLength: typeof msg.content === 'string' ? msg.content.length : msg.content.length
                        }));
                        
                        log.error('Conversation structure error. Current conversation:', { 
                            conversationLength: this.conversation.length,
                            conversation: conversationDebug 
                        });
                    }
                    if (error.message.includes('429') || error.message.includes('529')) {
                        if (attempt < maxRetries) {
                            const delay = attempt * retryDelayMs;
                            const errorType = error.message.includes('429') ? 'Rate limit' : 'Server overload';
                            log.debug(`${errorType} hit, attempt ${attempt}/${maxRetries}. Retrying in ${delay / 1000} seconds...`);
                            await new Promise<void>((resolve) => {
                                setTimeout(() => resolve(), delay);
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
                }
                // For other errors, throw immediately
                throw error;
            }
        }
        throw lastError ?? new Error('Unknown error after retries in createMessageWithRetry');
    }

    async handleLLMResponse(client: Client, response: Message, sseEmit: (role: string, content: string | ContentBlockParam[]) => void, toolCallCount = 0) {
        log.debug(`[internal] handleLLMResponse: ${JSON.stringify(response)}`);
        for (const block of response.content) {
            if (block.type === 'text') {
                this.conversation.push({ role: 'assistant', content: block.text || '' });
                log.debug(`[internal] emitting SSE text message: ${block.text}`);
                sseEmit('assistant', block.text || '');
            } else if (block.type === 'tool_use') {
                if (toolCallCount >= this.maxNumberOfToolCallsPerQuery) {
                    const msg = `Too many tool calls in a single turn! This has been implemented to prevent infinite loops.
                        Limit is ${this.maxNumberOfToolCallsPerQuery}.
                        You can increase the limit by setting the "maxNumberOfToolCallsPerQuery" parameter.`;
                    this.conversation.push({ role: 'assistant', content: msg });
                    log.debug(`[internal] emitting SSE tool limit message: ${msg}`);
                    sseEmit('assistant', msg);
                    const finalResponse = await this.createMessageWithRetry();
                    this.conversation.push({ role: 'assistant', content: finalResponse.content || '' });
                    log.debug(`[internal] emitting SSE tool limit final message: ${finalResponse.content}`);
                    sseEmit('assistant', finalResponse.content || '');
                    return;
                }
                const msgAssistant = {
                    role: 'assistant' as const,
                    content: [{ id: block.id, input: block.input, name: block.name, type: 'tool_use' as const }],
                };
                this.conversation.push(msgAssistant);
                log.debug(`[internal] emitting SSE tool_use message: ${JSON.stringify(msgAssistant)}`);
                sseEmit(msgAssistant.role, msgAssistant.content);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const params = { name: block.name, arguments: block.input as any };
                log.debug(`[internal] Calling tool (count: ${toolCallCount}): ${JSON.stringify(params)}`);
                // Enhanced tool result message structure
                const msgUser = {
                    role: 'user' as const,
                    content: [{
                        tool_use_id: block.id,
                        type: 'tool_result' as const,
                        content: [] as any[], // Will be array of content blocks
                        is_error: false,
                    }],
                };
                try {
                    const results = await client.callTool(params, CallToolResultSchema, { timeout: this.toolCallTimeoutSec * 1000 });
                    
                    // Enhanced content processing for images and mixed content
                    if (results.content instanceof Array && results.content.length !== 0) {
                        const processedContent: any[] = [];
                        processedContent.push({ 
                            type: 'text',
                            text: `Tool "${params.name}" executed successfully. Results:`
                        }); // Tool execution info at the beginning
                        for (const item of results.content) {
                            if (item.type === 'image' && item.data) {
                                // Detect image format from base64 data
                                const imageData = item.data;
                                let mediaType = 'image/png';
                                
                                try {
                                    // Check the base64 data signature to determine format
                                    const header = imageData.substring(0, 20);
                                    
                                    // JPEG signatures
                                    if (header.startsWith('/9j/') || header.startsWith('iVBORw0KGgo')) {
                                        if (header.startsWith('/9j/')) {
                                            mediaType = 'image/jpeg';
                                        } else if (header.startsWith('iVBORw0KGgo')) {
                                            mediaType = 'image/png';
                                        }
                                    } else {
                                        // Try to decode and check binary signature
                                        const binaryString = atob(imageData.substring(0, 20));
                                        const bytes = new Uint8Array(binaryString.length);
                                        for (let i = 0; i < binaryString.length; i++) {
                                            bytes[i] = binaryString.charCodeAt(i);
                                        }
                                        
                                        // PNG signature: 89 50 4E 47 0D 0A 1A 0A
                                        if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
                                            mediaType = 'image/png';
                                        }
                                        // JPEG signature: FF D8 FF
                                        else if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
                                            mediaType = 'image/jpeg';
                                        }
                                        // WebP signature: RIFF...WEBP
                                        else if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
                                            mediaType = 'image/webp';
                                        }
                                    }
                                } catch (error) {
                                    log.warning(`Could not detect image format, using default PNG: ${error}`);
                                    mediaType = 'image/png';
                                }
                                
                                log.debug(`Detected image format: ${mediaType}`);
                                processedContent.push({
                                    type: 'image',
                                    source: {
                                        type: 'base64',
                                        media_type: mediaType,
                                        data: imageData
                                    }
                                });
                            } else if (item.type === 'text' && item.text) {
                                processedContent.push({
                                    type: 'text',
                                    text: item.text
                                });
                            } else if (item.data) {
                                processedContent.push({
                                    type: 'text',
                                    text: typeof item.data === 'string' ? item.data : JSON.stringify(item.data, null, 2)
                                });
                            }
                        }
                        
                        // Set the processed content
                        msgUser.content[0].content = processedContent;
                    } else {
                        msgUser.content[0].content = [{
                            type: 'text',
                            text: `No results retrieved from ${params.name}`
                        }];
                        msgUser.content[0].is_error = true;
                    }
                } catch (error) {
                    log.error(`Error when calling tool ${params.name}: ${error}`);
                    msgUser.content[0].content = [{
                        type: 'text',
                        text: `Error when calling tool ${params.name}, error: ${error}`
                    }];
                    msgUser.content[0].is_error = true;
                }
                // Always add the tool result to the conversation and emit it
                this.conversation.push(msgUser);
                log.debug(`[internal] emitting SSE tool_result message: ${JSON.stringify(msgUser)}`);
                sseEmit(msgUser.role, msgUser.content);
                // Get next response from Claude
                log.debug('[internal] Get model response from tool result');
                const nextResponse: Message = await this.createMessageWithRetry();
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
            const response = await this.createMessageWithRetry();
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
