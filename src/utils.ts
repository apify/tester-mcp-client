import type { ContentBlockParam, MessageParam } from '@anthropic-ai/sdk/resources';
import { log } from 'apify';

export function isBase64(str: string): boolean {
    if (!str) {
        return false;
    }
    try {
        return btoa(atob(str)) === str;
    } catch {
        return false;
    }
}

/**
* Prunes base64 encoded messages from the conversation and replaces them with a placeholder to save context tokens.
* Also adds fake tool_result messages for tool_use messages that don't have a corresponding tool_result message.
* Also adds fake tool_use messages for tool_result messages that don't have a corresponding tool_use message.
* Ensures tool_result blocks reference valid tool_use IDs.
* @param conversation
* @returns
*/
export function pruneAndFixConversation(conversation: MessageParam[]): MessageParam[] {
    // Create a shallow copy of the conversation array
    const prunedAndFixedConversation: MessageParam[] = [];

    // Maps tool use blockID to message index
    const toolUseMap = new Map<string, number>();
    // Maps tool result tool use block ID to message index
    const toolResultMap = new Map<string, number>();

    // First pass: prune base64 content and collect tool IDs
    for (let m = 0; m < conversation.length; m++) {
        const message = conversation[m];

        // Handle simple string messages
        if (typeof message.content === 'string') {
            prunedAndFixedConversation.push({
                ...message,
                content: isBase64(message.content) ? '[Base64 encoded content]' : message.content,
            });
            continue;
        }

        // Handle messages with content blocks
        const contentBlocks = message.content as ContentBlockParam[];
        const processedBlocks = contentBlocks.map((block) => {
            // Handle different block types
            if (block.type === 'text' && isBase64(block.text)) {
                return {
                    type: 'text',
                    text: '[Base64 encoded content]',
                    cache_control: block.cache_control,
                    citations: block.citations,
                };
            }

            if (block.type === 'tool_use') {
                toolUseMap.set(block.id, m);
                return block;
            }

            if (block.type === 'tool_result') {
                toolResultMap.set(block.tool_use_id, m);

                // Handle base64 encoded tool_result content (string)
                if (typeof block.content === 'string' && isBase64(block.content)) {
                    return {
                        type: 'tool_result',
                        content: '[Base64 encoded content]',
                        tool_use_id: block.tool_use_id,
                        is_error: block.is_error,
                        cache_control: block.cache_control,
                    };
                }

                // Handle base64 encoded tool_result content (array)
                if (Array.isArray(block.content)) {
                    const processedContent = block.content.map((contentBlock) => {
                        if (contentBlock.type === 'text' && isBase64(contentBlock.text)) {
                            return {
                                type: 'text',
                                text: '[Base64 encoded content]',
                                cache_control: contentBlock.cache_control,
                                citations: contentBlock.citations,
                            };
                        }
                        return contentBlock;
                    });

                    return {
                        type: 'tool_result',
                        content: processedContent,
                        tool_use_id: block.tool_use_id,
                        is_error: block.is_error,
                        cache_control: block.cache_control,
                    };
                }
            }

            return block;
        }) as ContentBlockParam[];

        prunedAndFixedConversation.push({
            role: message.role,
            content: processedBlocks,
        });
    }

    // Find missing tool use/result relationships
    const toolResultBlocksWithoutUse = [];
    const toolUseBlocksWithoutResult = [];

    // Find missing relationships
    for (const id of toolResultMap.keys()) {
        if (!toolUseMap.has(id)) {
            toolResultBlocksWithoutUse.push(id);
        }
    }

    for (const id of toolUseMap.keys()) {
        if (!toolResultMap.has(id)) {
            toolUseBlocksWithoutResult.push(id);
        }
    }

    // If no fixes needed, return the pruned conversation
    if (toolResultBlocksWithoutUse.length === 0 && toolUseBlocksWithoutResult.length === 0) {
        return prunedAndFixedConversation;
    }

    // Group missing relationships by message index
    const toolResultMessagesWithoutUse = new Map<number, string[]>();
    for (const id of toolResultBlocksWithoutUse) {
        const messageIndex = toolResultMap.get(id);
        if (messageIndex !== undefined) {
            const existingIds = toolResultMessagesWithoutUse.get(messageIndex) || [];
            existingIds.push(id);
            toolResultMessagesWithoutUse.set(messageIndex, existingIds);
        }
    }

    const toolUseMessagesWithoutResult = new Map<number, string[]>();
    for (const id of toolUseBlocksWithoutResult) {
        const messageIndex = toolUseMap.get(id);
        if (messageIndex !== undefined) {
            const existingIds = toolUseMessagesWithoutResult.get(messageIndex) || [];
            existingIds.push(id);
            toolUseMessagesWithoutResult.set(messageIndex, existingIds);
        }
    }

    // Insert dummy messages where needed (working backwards to avoid index shifting issues)
    for (let m = prunedAndFixedConversation.length - 1; m >= 0; m--) {
        if (toolResultMessagesWithoutUse.has(m)) {
            const blockIDs = toolResultMessagesWithoutUse.get(m) || [];
            log.debug(`Adding dummy message with tool_use blocks for tool_result IDs: ${blockIDs}`);
            prunedAndFixedConversation.splice(m, 0, {
                role: 'assistant',
                content: blockIDs.map((toolUseId) => ({
                    type: 'tool_use',
                    id: toolUseId,
                    name: 'unknown_tool',
                    input: {},
                })),
            });
        } else if (toolUseMessagesWithoutResult.has(m)) {
            // Don't add dummy tool_use for the last message
            if (m === prunedAndFixedConversation.length - 1) {
                log.debug(`Skipping dummy message for last tool_use message at index ${m}`);
                continue;
            }

            const blockIDs = toolUseMessagesWithoutResult.get(m) || [];
            log.debug(`Adding dummy message with tool_result blocks for tool_use IDs: ${blockIDs}`);
            prunedAndFixedConversation.splice(m + 1, 0, {
                role: 'user',
                content: blockIDs.map((toolUseId) => ({
                    type: 'tool_result',
                    tool_use_id: toolUseId,
                    content: '[Tool use without result - most likely tool failed or response was too large to be sent to LLM]',
                })),
            });
        }
    }

    return prunedAndFixedConversation;
}
