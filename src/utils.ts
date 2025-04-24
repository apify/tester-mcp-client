import type { ContentBlockParam, MessageParam } from '@anthropic-ai/sdk/resources';
import { log } from 'apify';

/**
* Adds fake tool_result messages for tool_use messages that don't have a corresponding tool_result message.
* @param conversation
* @returns
*/
export function fixConversation(conversation: MessageParam[]): MessageParam[] {
    // Storing both in case the messages are in the wrong order
    const toolUseIDs = new Set<string>();
    const toolResultIDs = new Set<string>();

    for (let m = 0; m < conversation.length; m++) {
        const message = conversation[m];

        if (typeof message.content === 'string') continue;

        // Handle messages with content blocks
        const contentBlocks = message.content as ContentBlockParam[];
        for (let i = 0; i < contentBlocks.length; i++) {
            const block = contentBlocks[i];
            if (block.type === 'tool_use') {
                toolUseIDs.add(block.id);
            } else if (block.type === 'tool_result') {
                toolResultIDs.add(block.tool_use_id);
            }
        }
    }

    const fixedConversation: MessageParam[] = [];
    const toolUseIDsWithoutResult = Array.from(toolUseIDs).filter((id) => !toolResultIDs.has(id));

    if (toolUseIDsWithoutResult.length === 0) {
        return conversation.slice();
    }

    for (let m = 0; m < conversation.length; m++) {
        const message = conversation[m];

        fixedConversation.push(message);
        // Handle messages with content blocks
        if (typeof message.content === 'string') continue;

        const contentBlocks = message.content as ContentBlockParam[];
        for (let i = 0; i < contentBlocks.length; i++) {
            const block = contentBlocks[i];
            if (block.type === 'tool_use' && toolUseIDsWithoutResult.includes(block.id)) {
                log.debug(`Adding fake tool_result message for tool_use with ID: ${block.id}`);
                fixedConversation.push({
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
    return fixedConversation;
}
