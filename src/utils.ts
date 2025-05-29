import type { ContentBlockParam, MessageParam } from '@anthropic-ai/sdk/resources';

import { IMAGE_BASE64_PLACEHOLDER } from './const.js';

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

    // First pass: prune base64 content and collect tool IDs
    for (let m = 0; m < conversation.length; m++) {
        const message = conversation[m];

        // Handle simple string messages
        if (typeof message.content === 'string') {
            prunedAndFixedConversation.push({
                ...message,
                content: isBase64(message.content) ? IMAGE_BASE64_PLACEHOLDER : message.content,
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
                    text: IMAGE_BASE64_PLACEHOLDER,
                    cache_control: block.cache_control,
                    citations: block.citations,
                };
            }

            if (block.type === 'tool_use') {
                return block;
            }

            if (block.type === 'tool_result') {
                // Handle base64 encoded tool_result content (string)
                if (typeof block.content === 'string' && isBase64(block.content)) {
                    return {
                        type: 'tool_result',
                        content: IMAGE_BASE64_PLACEHOLDER,
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

    // If first message is an user with tool_result we need to add a dummy assistant message
    // with a tool_use blocks to ensure the conversation is valid
    const firstMessage = prunedAndFixedConversation[0];
    // Get all tool_result blocks from the first message
    const firstMessageToolResultBlocks = typeof firstMessage.content === 'string' ? [] : firstMessage.content.filter(
        (block) => block.type === 'tool_result',
    );
    if (firstMessageToolResultBlocks.length > 0) {
        if (firstMessage.role !== 'user') {
            // just a sanity check
            throw new Error('Message with tool_result must be from user');
        }

        // Add a dummy assistant message with a tool_use block for each tool_result block
        prunedAndFixedConversation.unshift({
            role: 'assistant',
            content: firstMessageToolResultBlocks.map((block) => ({
                type: 'tool_use',
                id: block.tool_use_id,
                name: '[unknown tool - this was added by the conversation manager to keep the conversation valid]',
                input: {},
            })),
        });
    }

    return prunedAndFixedConversation;
}
