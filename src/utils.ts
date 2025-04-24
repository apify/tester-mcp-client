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
* @param conversation
* @returns
*/
export function pruneAndFixConversation(conversation: MessageParam[]): MessageParam[] {
    const prunedConversation = JSON.parse(JSON.stringify(conversation)) as MessageParam[];
    // Storing both in case the messages are in wrong order
    const toolUseIDs = new Set<string>();
    const toolResultIDs = new Set<string>();

    for (let m = 0; m < prunedConversation.length; m++) {
        const message = prunedConversation[m];

        // Handle simple string messages
        if (typeof message.content === 'string' && isBase64(message.content)) {
            prunedConversation[m] = {
                role: message.role,
                content: '[Base64 encoded content]',
            };
            continue;
        }

        // Handle messages with content blocks
        const contentBlocks = message.content as ContentBlockParam[];
        for (let i = 0; i < contentBlocks.length; i++) {
            const block = contentBlocks[i];
            // Handle base64 encoded content
            if (block.type === 'text' && isBase64(block.text)) {
                contentBlocks[i] = {
                    type: 'text',
                    text: '[Base64 encoded content]',
                };
            } else if (block.type === 'tool_result' && typeof block.content === 'string' && isBase64(block.content)) {
                contentBlocks[i] = {
                    type: 'tool_result',
                    content: '[Base64 encoded content]',
                    tool_use_id: block.tool_use_id,
                    is_error: block.is_error,
                    cache_control: block.cache_control,
                };
            } else if (block.type === 'tool_result' && Array.isArray(block.content)) {
                for (let j = 0; j < block.content.length; j++) {
                    const contentBlock = block.content[j];
                    if (contentBlock.type === 'text' && isBase64(contentBlock.text)) {
                        block.content[j] = {
                            type: 'text',
                            text: '[Base64 encoded content]',
                            cache_control: contentBlock.cache_control,
                            citations: contentBlock.citations,
                        };
                    }
                }
            }

            // Handle tool calls
            if (block.type === 'tool_use') {
                toolUseIDs.add(block.id);
            } else if (block.type === 'tool_result') {
                toolResultIDs.add(block.tool_use_id);
            }
        }
    }

    // Remove tool_use messages without corresponding tool_result messages
    // const toolUseIDsWithoutResult = toolUseIDs.difference(toolResultIDs);
    const toolUseIDsWithoutResult = Array.from(toolUseIDs).filter((id) => !toolResultIDs.has(id));

    if (toolUseIDsWithoutResult.length < 1) {
        return prunedConversation;
    }

    for (let m = 0; m < prunedConversation.length; m++) {
        const message = prunedConversation[m];

        // Skip messages that are not tool_use
        if (typeof message.content === 'string') continue;

        // Handle messages with content blocks
        const contentBlocks = message.content as ContentBlockParam[];
        for (let i = 0; i < contentBlocks.length; i++) {
            const block = contentBlocks[i];

            if (block.type === 'tool_use' && toolUseIDsWithoutResult.includes(block.id)) {
                log.debug(`Adding fake tool_result message for tool_use with ID: ${block.id}`);
                prunedConversation.push({
                    role: 'user',
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: block.id,
                            content: '[Tool use without result - reason unknown, most likely tool failed]',
                        },
                    ],
                });
            }
        }
    }

    return prunedConversation;
}
