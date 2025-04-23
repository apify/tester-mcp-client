import type { ContentBlockParam, MessageParam } from '@anthropic-ai/sdk/resources';

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

export function pruneConversation(conversation: MessageParam[]): MessageParam[] {
    const prunedConversation = JSON.parse(JSON.stringify(conversation)) as MessageParam[];

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
        }
    }

    return prunedConversation;
}
