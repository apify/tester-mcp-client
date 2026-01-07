import type { JSONValue } from '@ai-sdk/provider';
import type {
    AssistantModelMessage,
    ModelMessage,
    ToolResultOutput,
    ToolResultPart,
    UserModelMessage,
} from '@ai-sdk/provider-utils';

export type LegacyToolUseBlock = {
    type: 'tool_use';
    id: string;
    name: string;
    input: unknown;
};

export type LegacyToolResultBlock = {
    type: 'tool_result';
    tool_use_id: string;
    content: unknown;
    is_error?: boolean;
};

export type LegacyTextBlock = {
    type: 'text';
    text: string;
};

export type LegacyContentBlock = LegacyToolUseBlock | LegacyToolResultBlock | LegacyTextBlock;

export type LegacyMessage = {
    role: 'user' | 'assistant' | 'system';
    content: string | LegacyContentBlock[];
};

export type LegacyConversation = LegacyMessage[];
const normalizeToolResultOutput = (output: ToolResultOutput): { content: unknown; isError: boolean } => {
    switch (output.type) {
        case 'content': {
            const content = output.value.map((item) => {
                if (item.type === 'text') {
                    return { type: 'text', text: item.text };
                }
                if (item.type === 'file-data') {
                    if (item.mediaType.startsWith('image/')) {
                        return {
                            type: 'image',
                            data: item.data,
                            source: { media_type: item.mediaType },
                        };
                    }
                    return {
                        type: 'text',
                        text: `File (${item.mediaType}) received.`,
                    };
                }
                if (item.type === 'file-url') {
                    return { type: 'text', text: `File URL: ${item.url}` };
                }
                if (item.type === 'media') {
                    return {
                        type: 'image',
                        data: item.data,
                        source: { media_type: item.mediaType },
                    };
                }
                return { type: 'text', text: JSON.stringify(item) };
            });
            return { content, isError: false };
        }
        case 'text':
            return { content: output.value, isError: false };
        case 'json':
            return { content: JSON.stringify(output.value, null, 2), isError: false };
        case 'execution-denied':
            return { content: output.reason ?? 'Tool execution denied.', isError: true };
        case 'error-text':
            return { content: output.value, isError: true };
        case 'error-json':
            return { content: JSON.stringify(output.value, null, 2), isError: true };
        default:
            return { content: JSON.stringify(output), isError: true };
    }
};

const toolResultPartToLegacy = (part: ToolResultPart): LegacyToolResultBlock => {
    const { content, isError } = normalizeToolResultOutput(part.output);
    return {
        type: 'tool_result',
        tool_use_id: part.toolCallId,
        content,
        is_error: isError,
    };
};

export const modelMessagesToLegacyConversation = (messages: ModelMessage[]): LegacyConversation => {
    const result: LegacyConversation = [];
    for (const message of messages) {
        if (message.role === 'system') {
            continue;
        }
        if (message.role === 'user') {
            if (typeof message.content === 'string') {
                result.push({ role: 'user', content: message.content });
                continue;
            }
            result.push({
                role: 'user',
                content: [{ type: 'text', text: JSON.stringify(message.content) }],
            });
            continue;
        }
        if (message.role === 'assistant') {
            const assistant = message as AssistantModelMessage;
            if (typeof assistant.content === 'string') {
                result.push({ role: 'assistant', content: assistant.content });
                continue;
            }
            for (const part of assistant.content) {
                if (part.type === 'text') {
                    result.push({ role: 'assistant', content: part.text });
                    continue;
                }
                if (part.type === 'tool-call') {
                    result.push({
                        role: 'assistant',
                        content: [{
                            type: 'tool_use',
                            id: part.toolCallId,
                            name: part.toolName,
                            input: part.input,
                        }],
                    });
                }
            }
            continue;
        }
        if (message.role === 'tool') {
            const toolMessage = message as { role: 'tool'; content: ToolResultPart[] };
            for (const part of toolMessage.content) {
                result.push({
                    role: 'user',
                    content: [toolResultPartToLegacy(part)],
                });
            }
        }
    }
    return result;
};

const legacyToolResultToOutput = (block: LegacyToolResultBlock): ToolResultOutput => {
    if (typeof block.content === 'string') {
        return { type: block.is_error ? 'error-text' : 'text', value: block.content };
    }
    return { type: block.is_error ? 'error-json' : 'json', value: block.content as JSONValue };
};

export const legacyConversationToModelMessages = (conversation: LegacyConversation): ModelMessage[] => {
    const result: ModelMessage[] = [];
    for (const message of conversation) {
        if (typeof message.content === 'string') {
            if (message.role === 'user') {
                result.push({ role: 'user', content: message.content } as UserModelMessage);
            } else if (message.role === 'assistant') {
                result.push({ role: 'assistant', content: message.content } as AssistantModelMessage);
            }
            continue;
        }
        const blocks = message.content;
        if (blocks.length === 0) {
            continue;
        }
        if (message.role === 'assistant') {
            const toolCalls = blocks.filter((block) => block.type === 'tool_use') as LegacyToolUseBlock[];
            if (toolCalls.length > 0) {
                result.push({
                    role: 'assistant',
                    content: toolCalls.map((block) => ({
                        type: 'tool-call',
                        toolCallId: block.id,
                        toolName: block.name,
                        input: block.input,
                    })),
                } as AssistantModelMessage);
            }
            const textBlocks = blocks.filter((block) => block.type === 'text') as LegacyTextBlock[];
            for (const block of textBlocks) {
                result.push({ role: 'assistant', content: block.text } as AssistantModelMessage);
            }
            continue;
        }
        const toolResults = blocks.filter((block) => block.type === 'tool_result') as LegacyToolResultBlock[];
        if (toolResults.length > 0) {
            result.push({
                role: 'tool',
                content: toolResults.map((block) => ({
                    type: 'tool-result',
                    toolCallId: block.tool_use_id,
                    toolName: 'unknown',
                    output: legacyToolResultToOutput(block),
                })),
            });
        }
    }
    return result;
};

export const coerceStoredConversation = (raw: unknown): ModelMessage[] => {
    if (!Array.isArray(raw)) {
        return [];
    }
    if (raw.length === 0) {
        return [];
    }
    const hasLegacyBlocks = raw.some((message) => {
        if (!message || typeof message !== 'object') {
            return false;
        }
        const { content } = message as LegacyMessage;
        return Array.isArray(content) && content.some((block) => block && typeof block === 'object'
            && ('type' in block) && (block.type === 'tool_use' || block.type === 'tool_result'));
    });
    if (hasLegacyBlocks) {
        return legacyConversationToModelMessages(raw as LegacyConversation);
    }
    return raw as ModelMessage[];
};

export const toolResultToLegacyBlock = (toolCallId: string, output: ToolResultOutput) => {
    const { content, isError } = normalizeToolResultOutput(output);
    return {
        type: 'tool_result',
        tool_use_id: toolCallId,
        content,
        is_error: isError,
    };
};
