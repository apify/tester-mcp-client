/**
 * Create an MCP client that connects to the server using SSE transport
 *
 */

import { Anthropic } from '@anthropic-ai/sdk';
import type { ContentBlockParam, Message, MessageParam, TextBlockParam, ImageBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { SemanticConventions } from '@arizeai/openinference-semantic-conventions';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ListToolsResult, Notification, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Tracer } from '@opentelemetry/api';
import { log } from 'apify';
import { EventSource } from 'eventsource';

import type { MessageParamWithBlocks, TokenCharger, Tool } from './types.js';
import { pruneAndFixConversation } from './utils.js';

if (typeof globalThis.EventSource === 'undefined') {
    globalThis.EventSource = EventSource as unknown as typeof globalThis.EventSource;
}

// Define a default, can be overridden in constructor
const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;
// Define a safety margin to avoid edge cases
const CONTEXT_TOKEN_SAFETY_MARGIN = 0.99;
// Minimum number of messages to keep in the conversation
// This keeps one round of user and assistant messages
const MIN_CONVERSATION_LENGTH = 2;

export class ConversationManager {
    private conversation: MessageParam[] = [];
    private anthropic: Anthropic;
    private systemPrompt: string;
    private modelName: string;
    private modelMaxOutputTokens: number;
    private maxNumberOfToolCallsPerQueryRound: number;
    private toolCallTimeoutSec: number;
    private readonly tokenCharger: TokenCharger | null;
    private tools: Tool[] = [];
    private readonly maxContextTokens: number;
    private readonly sessionId: string;

    private readonly tracer: Tracer;

    constructor(
        systemPrompt: string,
        modelName: string,
        apiKey: string,
        modelMaxOutputTokens: number,
        maxNumberOfToolCallsPerQuery: number,
        toolCallTimeoutSec: number,
        tracer: Tracer,
        tokenCharger: TokenCharger | null = null,
        persistedConversation: MessageParam[] = [],
        maxContextTokens: number = DEFAULT_MAX_CONTEXT_TOKENS,
        sessionId: string = crypto.randomUUID(),
    ) {
        this.systemPrompt = systemPrompt;
        this.modelName = modelName;
        this.modelMaxOutputTokens = modelMaxOutputTokens;
        this.maxNumberOfToolCallsPerQueryRound = maxNumberOfToolCallsPerQuery;
        this.toolCallTimeoutSec = toolCallTimeoutSec;
        this.tracer = tracer;
        this.tokenCharger = tokenCharger;
        this.anthropic = new Anthropic({ apiKey });
        this.conversation = [...persistedConversation];
        this.maxContextTokens = Math.floor(maxContextTokens * CONTEXT_TOKEN_SAFETY_MARGIN);
        this.sessionId = sessionId;
    }

    /**
     * Returns a flattened version of the conversation history, splitting messages with multiple content blocks
     * into separate messages for each block. Text blocks are returned as individual messages with string content,
     * while tool_use and tool_result blocks are returned as messages with a single-element content array.
     *
     * This is needed because of how the frontend client expects the conversation history to be structured.
     *
     * @returns {MessageParam[]} The flattened conversation history, with each message containing either a string (for text)
     *                           or an array with a single tool_use/tool_result block.
     */
    getConversation(): MessageParam[] {
        // split messages blocks into separate messages with text or single block
        const result: MessageParam[] = [];
        for (const message of this.conversation) {
            if (typeof message.content === 'string') {
                result.push(message);
                continue;
            }

            // Handle messages with content blocks
            for (const block of message.content) {
                if (block.type === 'text') {
                    result.push({
                        role: message.role,
                        content: block.text || '',
                    });
                } else if (block.type === 'tool_use' || block.type === 'tool_result') {
                    result.push({
                        role: message.role,
                        content: [block],
                    });
                }
            }
        }

        return result;
    }

    resetConversation() {
        this.conversation = [];
    }

    getSessionId(): string {
        return this.sessionId;
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
        if (settings.maxNumberOfToolCallsPerQuery !== undefined) this.maxNumberOfToolCallsPerQueryRound = settings.maxNumberOfToolCallsPerQuery;
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
        if (this.conversation.length <= MIN_CONVERSATION_LENGTH) {
            return;
        }

        let currentTokens = await this.countTokens(this.conversation);
        log.debug(`[Context truncation] Current token count: ${currentTokens}, max allowed: ${this.maxContextTokens}`);
        if (currentTokens <= this.maxContextTokens) {
            log.info(`[Context truncation] Current token count (${currentTokens}) is within limit (${this.maxContextTokens}). No truncation needed.`);
            return;
        }

        log.info(`[Context truncation] Current token count (${currentTokens}) exceeds limit (${this.maxContextTokens}). Truncating conversation...`);
        const initialMessagesCount = this.conversation.length;

        while (currentTokens > this.maxContextTokens && this.conversation.length > MIN_CONVERSATION_LENGTH) {
            try {
                log.debug(`[Context truncation] Current token count: ${currentTokens}, removing oldest message... total messages length: ${this.conversation.length}`);
                // Truncate oldest user and assistant messages round
                // This has to be done because otherwise if we just remove the oldest message
                // we end up with more context token than we started with (it does not make sense but it happens)
                this.conversation.shift();
                this.conversation.shift();
                this.printConversation();
                this.conversation = pruneAndFixConversation(this.conversation);
                currentTokens = await this.countTokens(this.conversation);
                log.debug(`[Context truncation] New token count after removal: ${currentTokens}`);
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

    /**
     * @internal
     * Debugging helper function that prints the current conversation state to the log.
     * Iterates through all messages in the conversation, logging their roles and a truncated preview of their content.
     * For messages with content blocks, logs details for each block, including text, tool usage, and tool results.
     * Useful for inspecting the structure and flow of the conversation during development or troubleshooting.
     */
    private printConversation() {
        log.debug(`[internal] createMessageWithRetry conversation length: ${this.conversation.length}`);
        for (const message of this.conversation) {
            log.debug(`[internal] ----- createMessageWithRetry message role: ${message.role} -----`);
            if (typeof message.content === 'string') {
                log.debug(`[internal] createMessageWithRetry message content: ${message.role}: ${message.content.substring(0, 50)}...`);
                continue;
            }
            for (const block of message.content) {
                if (block.type === 'text') {
                    log.debug(`[internal] createMessageWithRetry block text: ${message.role}: ${block.text?.substring(0, 50)}...`);
                } else if (block.type === 'tool_use') {
                    log.debug(`[internal] createMessageWithRetry block tool_use: ${block.name}, input: ${JSON.stringify(block.input).substring(0, 50)}...`);
                } else if (block.type === 'tool_result') {
                    const content = typeof block.content === 'string' ? block.content.substring(0, 50) : JSON.stringify(block.content).substring(0, 50);
                    log.debug(`[internal] createMessageWithRetry block tool_result: ${block.tool_use_id}, content: ${content}...`);
                }
            }
        }
    }

    private async createMessageWithRetry(
        maxRetries = 3,
        retryDelayMs = 2000, // 2 seconds
    ): Promise<Message> {
        return this.tracer.startActiveSpan('createMessage', async (span) => {
            span.setAttribute(SemanticConventions.OPENINFERENCE_SPAN_KIND, 'llm');
            span.setAttribute(SemanticConventions.LLM_MODEL_NAME, this.modelName);
            span.setAttribute(SemanticConventions.SESSION_ID, this.sessionId);

            try {
                // Check context window before API call
                // TODO pruneAndFix could be a class function, I had it there but I had to revert because of images size
                this.conversation = pruneAndFixConversation(this.conversation);
                span.setAttribute(SemanticConventions.INPUT_VALUE, JSON.stringify(this.conversation));

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

                        span.setAttribute(SemanticConventions.LLM_TOKEN_COUNT_PROMPT, response.usage?.input_tokens ?? 0);
                        span.setAttribute(SemanticConventions.LLM_TOKEN_COUNT_COMPLETION, response.usage?.output_tokens ?? 0);
                        span.setAttribute(SemanticConventions.OUTPUT_VALUE, JSON.stringify(response.content));
                        span.setStatus({ code: 1 }); // SUCCESS

                        return response;
                    } catch (error) {
                        lastError = error as Error;
                        if (error instanceof Error) {
                            // Log conversation state for debugging
                            const hasStructureError = error.message.includes('tool_use_id')
                                || error.message.includes('tool_result')
                                || error.message.includes('at least one message');
                            if (hasStructureError) {
                                const conversationDebug = this.conversation.map((msg, index) => ({
                                    index,
                                    role: msg.role,
                                    contentTypes: Array.isArray(msg.content)
                                        ? msg.content.map((block) => block.type)
                                        : 'string',
                                    contentLength: typeof msg.content === 'string' ? msg.content.length : msg.content.length,
                                }));

                                log.error('Conversation structure error. Current conversation:', {
                                    conversationLength: this.conversation.length,
                                    conversation: conversationDebug,
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
                                        : 'Server is currently experiencing high load. Please try again in a few moments '
                                          + 'or consider switching to a different model.';
                                    throw new Error(errorMsg);
                                }
                            }
                        }
                        // For other errors, throw immediately
                        throw error;
                    }
                }
                throw lastError ?? new Error('Unknown error after retries in createMessageWithRetry');
            } catch (error) {
                span.recordException(error as Error);
                span.setStatus({ code: 2, message: error instanceof Error ? error.message : String(error) }); // ERROR
                throw error;
            } finally {
                span.end();
            }
        });
    }

    /**
     * Handles the response from the LLM (Large Language Model), processes text and tool_use blocks,
     * emits SSE events, manages tool execution, and recursively continues the conversation as needed.
     *
     * ## Flow:
     * 1. Processes all text blocks in the LLM response and emits them as assistant messages.
     * 2. Gathers all tool_use blocks:
     *    - If tool_use blocks are present and the tool call limit is reached, emits a warning and stops further tool calls.
     *    - Otherwise, emits tool_use blocks as assistant messages.
     *    - The assistant message (containing only text) is added to the conversation history.
     * 3. If there are no tool_use blocks, the function returns (end of this response cycle).
     * 4. For each tool_use block:
     *    - Calls the corresponding tool using the provided client.
     *    - Emits the tool result (or error) as a user message via SSE.
     *    - Appends the tool result to the conversation.
     * 5. After processing all tool_use blocks, requests the next response from the LLM (using updated conversation).
     * 6. Recursively calls itself to process the next LLM response, incrementing the tool call round counter.
     *
     * @param client - The MCP client used to call tools.
     * @param response - The LLM response message to process.
     * @param sseEmit - Function to emit SSE events to the client (role, content).
     * @param toolCallCountRound - The current round of tool calls for this query (used to enforce limits).
     * @returns A promise that resolves when the response and all recursive tool calls are fully processed.
     */
    async handleLLMResponse(
        client: Client,
        response: Message,
        sseEmit: (role: string, content: string | ContentBlockParam[]) => Promise<void>,
        toolCallCountRound = 0,
    ) {
        log.debug(`[internal] handleLLMResponse: ${JSON.stringify(response)}`);

        // Refactored: preserve block order as received
        const assistantMessage: MessageParamWithBlocks = {
            role: 'assistant',
            content: [],
        };
        const toolUseBlocks: ContentBlockParam[] = [];
        for (const block of response.content) {
            if (block.type === 'text') {
                assistantMessage.content.push(block);
                log.debug(`[internal] emitting SSE text message: ${block.text}`);
                await sseEmit('assistant', block.text || '');
            } else if (block.type === 'tool_use') {
                if (toolCallCountRound >= this.maxNumberOfToolCallsPerQueryRound) {
                    // Tool call limit hit before any tool_use is processed
                    const msg = `Too many tool calls in a single turn! This has been implemented to prevent infinite loops.\nLimit is ${this.maxNumberOfToolCallsPerQueryRound}.\nYou can increase the limit by setting the "maxNumberOfToolCallsPerQuery" parameter.`;
                    assistantMessage.content.push({
                        type: 'text',
                        text: msg,
                    });
                    log.debug(`[internal] emitting SSE tool limit message: ${msg}`);
                    await sseEmit('assistant', msg);
                    this.conversation.push(assistantMessage);
                    break;
                }
                assistantMessage.content.push(block);
                log.debug(`[internal] emitting SSE tool_use message: ${JSON.stringify(block)}`);
                await sseEmit('assistant', [block]);
                toolUseBlocks.push(block);
            }
        }
        // Add the assistant message to the conversation
        // Assistant's turn is finished here, now we proceed with user if there are tool_use blocks
        // if not we just return
        this.conversation.push(assistantMessage);
        // If no tool_use blocks, we can return early
        if (toolUseBlocks.length === 0) {
            log.debug('[internal] No tool_use blocks found, returning from handleLLMResponse');
            return;
        }

        // Handle tool_use blocks
        // call tools and append and emit tool result messages
        const userToolResultsMessage: MessageParamWithBlocks = {
            role: 'user',
            content: [],
        };
        for (const block of toolUseBlocks) {
            if (block.type !== 'tool_use') continue; // Type guard
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const params = { name: block.name, arguments: block.input as any };
            log.debug(`[internal] Calling tool (count: ${toolCallCountRound}): ${JSON.stringify(params)}`);
            const toolResultBlock: ContentBlockParam = {
                type: 'tool_result',
                tool_use_id: block.id,
                content: [],
                is_error: false,
            };

            await this.tracer.startActiveSpan('toolCall', async (span) => {
                span.setAttribute(SemanticConventions.OPENINFERENCE_SPAN_KIND, 'tool');
                span.setAttribute(SemanticConventions.TOOL_NAME, params.name);
                span.setAttribute(SemanticConventions.TOOL_PARAMETERS, JSON.stringify(params.arguments));
                span.setAttribute(SemanticConventions.SESSION_ID, this.sessionId);
                span.setAttribute('toolCallCount', toolCallCountRound);
                span.setAttribute('timeout', this.toolCallTimeoutSec);

                try {
                    const results = await client.callTool(params, CallToolResultSchema, { timeout: this.toolCallTimeoutSec * 1000 });
                    if (results && typeof results === 'object' && 'content' in results) {
                        toolResultBlock.content = this.processToolResults(results as CallToolResult, params.name);
                    } else {
                        log.warning(`Tool ${params.name} returned unexpected result format:`, results);
                        toolResultBlock.content = [{
                            type: 'text',
                            text: `Tool "${params.name}" returned unexpected result format: ${JSON.stringify(results, null, 2)}`,
                        }];
                    }
                    // span.setAttribute(SemanticConventions.OUTPUT_MIME_TYPE, toolResultBlock.type); // This breaks Phoenix UI
                    span.setAttribute(SemanticConventions.OUTPUT_VALUE, JSON.stringify(toolResultBlock.content));
                    span.setStatus({ code: 1 }); // SUCCESS
                } catch (error) {
                    log.error(`Error when calling tool ${params.name}: ${error}`);
                    toolResultBlock.content = [{
                        type: 'text',
                        text: `Error when calling tool ${params.name}, error: ${error}`,
                    }];
                    toolResultBlock.is_error = true;
                    span.recordException(error as Error);
                    span.setStatus({ code: 2, message: error instanceof Error ? error.message : String(error) }); // ERROR
                } finally {
                    span.end();
                }
            });

            userToolResultsMessage.content.push(toolResultBlock);
            log.debug(`[internal] emitting SSE tool_result message: ${JSON.stringify(toolResultBlock)}`);
            await sseEmit('user', [toolResultBlock]);
        }

        // Add the user tool results message to the conversation
        this.conversation.push(userToolResultsMessage);
        // If we have tool results, we need to get the next response from the model
        log.debug('[internal] Get model response from tool result');
        const nextResponse: Message = await this.createMessageWithRetry();
        log.debug('[internal] Received response from model');
        // Process the next response recursively
        await this.handleLLMResponse(client, nextResponse, sseEmit, toolCallCountRound + 1);
        log.debug('[internal] Finished processing tool result');
    }

    /**
     * Process a user query:
     * 1) Use Anthropic to generate a response (which may contain "tool_use").
     * 2) If "tool_use" is present, call the main actor's tool via `this.mcpClient.callTool()`.
     * 3) Return or yield partial results so we can SSE them to the browser.
     */
    async processUserQuery(client: Client, query: string, sseEmit: (role: string, content: string | ContentBlockParam[]) => Promise<void>): Promise<void> {
        return await this.tracer.startActiveSpan('processUserQuery', async (span) => {
            span.setAttribute(SemanticConventions.OPENINFERENCE_SPAN_KIND, 'agent');
            span.setAttribute(SemanticConventions.INPUT_VALUE, query);
            span.setAttribute(SemanticConventions.LLM_MODEL_NAME, this.modelName);
            span.setAttribute(SemanticConventions.SESSION_ID, this.sessionId);
            try {
                log.debug(`[internal] Call LLM with user query: ${JSON.stringify(query)}`);
                this.conversation.push({ role: 'user', content: query });

                const response = await this.createMessageWithRetry();
                log.debug(`[internal] Received response: ${JSON.stringify(response.content)}`);
                log.debug(`[internal] Token count: ${JSON.stringify(response.usage)}`);
                await this.handleLLMResponse(client, response, sseEmit);

                // Set output value from the final response
                const outputText = response.content
                    .filter((block) => block.type === 'text')
                    .map((block) => block.text)
                    .join('\n');
                if (outputText) {
                    span.setAttribute(SemanticConventions.OUTPUT_VALUE, outputText);
                }
                span.setStatus({ code: 1 }); // SUCCESS
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                this.conversation.push({ role: 'assistant', content: errorMsg });
                await sseEmit('assistant', errorMsg);
                span.recordException(error as Error);
                span.setStatus({ code: 2, message: errorMsg }); // ERROR
                throw new Error(errorMsg);
            } finally {
                span.end();
            }
        });
    }

    handleNotification(notification: Notification) {
        // Implement logic to handle the notification
        log.info(`Handling notification: ${JSON.stringify(notification)}`);
        // You can update the conversation or perform other actions based on the notification
    }

    /**
     * Process tool call results and convert them into appropriate content blocks
     */
    private processToolResults(results: CallToolResult, toolName: string): (TextBlockParam | ImageBlockParam)[] {
        if (!results.content || !Array.isArray(results.content) || results.content.length === 0) {
            return [{
                type: 'text',
                text: `No results retrieved from ${toolName}`,
            }];
        }
        const processedContent: (TextBlockParam | ImageBlockParam)[] = [];
        processedContent.push({
            type: 'text',
            text: `Tool "${toolName}" executed successfully. Results:`,
        });
        for (const item of results.content) {
            if (item.type === 'image' && item.data) {
                const mediaType = this.detectImageFormat(item.data);
                log.debug(`Detected image format: ${mediaType}`);
                processedContent.push({
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: mediaType,
                        data: item.data,
                    },
                });
                continue;
            }
            if (item.type === 'text' && item.text) {
                processedContent.push({
                    type: 'text',
                    text: item.text,
                });
                continue;
            }
            // Other data types
            if (item.data) {
                processedContent.push({
                    type: 'text',
                    text: typeof item.data === 'string' ? item.data : JSON.stringify(item.data, null, 2),
                });
            }
        }
        return processedContent;
    }

    /**
     * Detect image format from base64 data
     */
    private detectImageFormat(imageData: string): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' {
        try {
            const header = imageData.substring(0, 20);
            if (header.startsWith('/9j/')) {
                return 'image/jpeg';
            }
            if (header.startsWith('iVBORw0KGgo')) {
                return 'image/png';
            }
            // Binary signature detection
            const binaryString = atob(imageData.substring(0, 20));
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            // PNG signature: 89 50 4E 47 0D 0A 1A 0A
            if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
                return 'image/png';
            }
            if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
                return 'image/jpeg';
            }
            if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
                return 'image/webp';
            }
            return 'image/png'; // Default fallback
        } catch (error) {
            log.warning(`Could not detect image format, using default PNG: ${error}`);
            return 'image/png';
        }
    }
}
