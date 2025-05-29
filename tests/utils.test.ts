import type { MessageParam } from '@anthropic-ai/sdk/resources/index.js';
import { describe, it, expect } from 'vitest';

import { IMAGE_BASE64_PLACEHOLDER } from '../src/const.js';
import { pruneAndFixConversation } from '../src/utils.js';

describe('pruneAndFixConversation', () => {
    // Base 64 pruning
    it('should prune base64 encoded image content and replace with placeholder', () => {
    // A simple base64 string (not a real image, but enough for test)
        const base64String = 'aGVsbG8gd29ybGQ='; // "hello world" in base64
        const conversation = [
            { role: 'user', content: 'Show me an image' },
            {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'I will use image tool' },
                    { type: 'tool_use', id: 'tool_img', name: 'img_tool', input: {} },
                ],
            },
            {
                role: 'user',
                content: [
                    { type: 'tool_result', tool_use_id: 'tool_img', content: base64String },
                ],
            },
        ];

        const result = pruneAndFixConversation(conversation as MessageParam[]);

        // Check that conversation is preserved
        expect(result.length).toBe(conversation.length);
        expect(result[0].role).toBe('user');
        expect(result[0].content).toBe('Show me an image');
        expect(result[1].role).toBe('assistant');
        expect(result[1].content[0].type).toBe('text');
        expect(result[1].content[0].text).toBe('I will use image tool');
        expect(result[1].content[1].type).toBe('tool_use');
        expect(result[1].content[1].id).toBe('tool_img');
        expect(result[1].content[1].name).toBe('img_tool');

        // Check string message is replaced
        expect(result[2].content[0].content).toBe(IMAGE_BASE64_PLACEHOLDER);
    });

    // Orphaned tool calling
    it('should NOT add dummy tool_result for tool_use in the last message', () => {
        const conversation: MessageParam[] = [
            { role: 'user', content: 'scrape example com' },
            // This is the last message with a tool_use, so it should NOT get a dummy tool_result
            {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'I will use scraper tool' },
                    { id: 'last_tool', type: 'tool_use', name: 'scraper', input: { url: 'example.com' } },
                ],
            },
        ];

        const result = pruneAndFixConversation(conversation as MessageParam[]);

        // Check that the result length is the same as the original conversation
        expect(result.length).toBe(conversation.length);
        expect(result[0].role).toBe('user');
        expect(result[1].role).toBe('assistant');
        expect(result[1].content.length).toBe(2);
    });

    it('should add dummy tool use for orphaned tool result', () => {
        // it should add a message with a dummy tool use before the orphaned tool result
        // message
        const conversation: MessageParam[] = [
            {
                role: 'user',
                content: [
                    { type: 'tool_result', tool_use_id: 'orphaned_tool_id', content: 'some result' },
                ],
            },
            {
                role: 'assistant',
                content: 'that is some nice result you got there',
            },
        ];

        const result = pruneAndFixConversation(conversation as MessageParam[]);

        expect(result.length).toBe(3);
        // Check that the first message is a dummy tool use
        expect(result[0].role).toBe('assistant');
        expect(result[0].content[0].type).toBe('tool_use');
        expect(result[0].content[0].id).toBe('orphaned_tool_id');
        // Check that the second message is the original tool result
        expect(result[1].role).toBe('user');
        expect(result[1].content[0].type).toBe('tool_result');
        expect(result[1].content[0].tool_use_id).toBe('orphaned_tool_id');
        // Check that the third message is the original assistant message
        expect(result[2].role).toBe('assistant');
        expect(result[2].content).toBe('that is some nice result you got there');
    });

    it('should add dummy tool use for each orhapened tool result', () => {
        // it should add a message with a dummy tool use before each orphaned tool result
        const conversation: MessageParam[] = [
            {
                role: 'user',
                content: [
                    { type: 'tool_result', tool_use_id: 'orphaned_tool_id_1', content: 'result 1' },
                    { type: 'tool_result', tool_use_id: 'orphaned_tool_id_2', content: 'result 2' },
                ],
            },
            {
                role: 'assistant',
                content: 'that is some nice result you got there',
            },
        ];
        const result = pruneAndFixConversation(conversation as MessageParam[]);
        expect(result.length).toBe(3);
        // Check that the first message is a dummy tool use for all orphaned tool results
        expect(result[0].role).toBe('assistant');
        expect(result[0].content[0].type).toBe('tool_use');
        expect(result[0].content[0].id).toBe('orphaned_tool_id_1');
        expect(result[0].content[1].type).toBe('tool_use');
        expect(result[0].content[1].id).toBe('orphaned_tool_id_2');
        // Check that the second message is the first original tool result
        expect(result[1].role).toBe('user');
        expect(result[1].content[0].type).toBe('tool_result');
        expect(result[1].content[0].tool_use_id).toBe('orphaned_tool_id_1');
        // Check that the third message is the second original tool result
        expect(result[1].content[1].type).toBe('tool_result');
        expect(result[1].content[1].tool_use_id).toBe('orphaned_tool_id_2');
        // Check that the fourth message is the original assistant message
        expect(result[2].role).toBe('assistant');
        expect(result[2].content).toBe('that is some nice result you got there');
    });
});
