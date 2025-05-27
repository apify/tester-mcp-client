import type { MessageParam } from '@anthropic-ai/sdk/resources/index.js';
import { describe, it, expect } from 'vitest';

import { IMAGE_BASE64_PLACEHOLDER } from '../src/const.js';
import { pruneAndFixConversation } from '../src/utils.js';

describe('pruneAndFixConversation', () => {
    it('should add missing tool_result blocks for tool_use messages (except in last message)', () => {
        const conversation = [
            { role: 'user', content: 'scrape example com' },
            { role: 'assistant', content: "I'll help you scrape example.com." },
            { role: 'assistant', content: [{ id: 'tool_1', type: 'tool_use' }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: '[Tool use failed]' }] },
            // This is not the last message, so it should get a dummy tool_result
            { role: 'assistant', content: [{ id: 'tool_2', type: 'tool_use' }] },
            { role: 'user', content: 'What happened?' },
        ];

        const result = pruneAndFixConversation(conversation as MessageParam[]);

        expect(result).toContainEqual({
            role: 'user',
            content: [
                {
                    type: 'tool_result',
                    tool_use_id: 'tool_2',
                    content: '[Tool use without result - most likely tool failed or response was too large to be sent to LLM]',
                },
            ],
        });
    });

    it('should add missing tool_result blocks in the middle of messages', () => {
        const conversation = [
            { role: 'user', content: 'scrape example com' },
            { role: 'assistant', content: "I'll help you scrape example.com." },
            { role: 'assistant', content: [{ id: 'tool_1', type: 'tool_use' }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: '[Tool use failed]' }] },
            { role: 'assistant', content: [{ id: 'tool_2', type: 'tool_use' }] },
            { role: 'user', content: 'what happened?' },
        ];

        const result = pruneAndFixConversation(conversation as MessageParam[]);

        expect(result).toContainEqual({
            role: 'user',
            content: [
                {
                    type: 'tool_result',
                    tool_use_id: 'tool_2',
                    content: '[Tool use without result - most likely tool failed or response was too large to be sent to LLM]',
                },
            ],
        });
    });

    it('should add dummy tool_use blocks for orphaned tool_result messages', () => {
        const conversation = [
            { role: 'user', content: 'scrape example com' },
            { role: 'assistant', content: "I'll help you scrape example.com." },
            // Missing tool_use message with id 'orphaned_tool'
            {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'orphaned_tool',
                        content: 'Result from tool: web_scraper',
                    },
                ],
            },
            { role: 'assistant', content: "Here's what I found from scraping example.com" },
        ];

        const result = pruneAndFixConversation(conversation as MessageParam[]);

        // Check that a dummy tool_use block was added before the orphaned tool_result
        const dummyToolUseMessage = result.find(
            (msg) => msg.role === 'assistant'
                && Array.isArray(msg.content)
                && msg.content.some(
                    (block) => block.type === 'tool_use' && block.id === 'orphaned_tool',
                ),
        );

        expect(dummyToolUseMessage).toBeDefined();
        expect(dummyToolUseMessage?.content).toContainEqual(
            expect.objectContaining({
                type: 'tool_use',
                id: 'orphaned_tool',
                name: expect.any(String),
            }),
        );

        // Verify the order of messages is correct
        const dummyToolUseIndex = result.indexOf(dummyToolUseMessage!);
        const toolResultIndex = result.findIndex(
            (msg) => Array.isArray(msg.content)
                && msg.content.some(
                    (block) => block.type === 'tool_result' && block.tool_use_id === 'orphaned_tool',
                ),
        );

        expect(dummyToolUseIndex).toBe(toolResultIndex - 1);
    });

    it('should handle multiple orphaned tool_result blocks in the same message', () => {
        const conversation = [
            { role: 'user', content: 'run multiple tools' },
            {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'orphaned_tool_1',
                        content: 'Result from tool: tool_1',
                    },
                    {
                        type: 'tool_result',
                        tool_use_id: 'orphaned_tool_2',
                        content: 'Result from tool: tool_2',
                    },
                ],
            },
        ];

        const result = pruneAndFixConversation(conversation as MessageParam[]);

        // Find the dummy tool_use message
        const dummyToolUseMessage = result.find(
            (msg) => msg.role === 'assistant'
                && Array.isArray(msg.content)
                && msg.content.some(
                    (block) => block.type === 'tool_use'
                    && (block.id === 'orphaned_tool_1' || block.id === 'orphaned_tool_2'),
                ),
        );

        expect(dummyToolUseMessage).toBeDefined();

        // Check that both tool_use blocks were created
        const toolUseBlocks = Array.isArray(dummyToolUseMessage?.content)
            ? dummyToolUseMessage?.content.filter((block) => block.type === 'tool_use')
            : [];

        expect(toolUseBlocks.length).toBe(2);
        expect(toolUseBlocks).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: 'orphaned_tool_1' }),
                expect.objectContaining({ id: 'orphaned_tool_2' }),
            ]),
        );

        // Verify the order of messages is correct
        const dummyToolUseIndex = result.indexOf(dummyToolUseMessage!);
        const toolResultIndex = result.findIndex(
            (msg) => Array.isArray(msg.content)
                && msg.content.some(
                    (block) => block.type === 'tool_result'
                    && (block.tool_use_id === 'orphaned_tool_1' || block.tool_use_id === 'orphaned_tool_2'),
                ),
        );
        expect(dummyToolUseIndex).toBe(toolResultIndex - 1);
    });

    it('should add dummy tool_use for orphaned tool_result in the middle of a conversation', () => {
        const conversation = [
            { role: 'user', content: 'Let\'s have a conversation' },
            { role: 'assistant', content: 'Sure, what would you like to talk about?' },
            { role: 'user', content: 'Tell me about web scraping' },
            { role: 'assistant', content: 'Web scraping is a technique to extract data from websites.' },
            // Normal tool use and result
            { role: 'assistant', content: [{ id: 'normal_tool', type: 'tool_use', name: 'search', input: { query: 'web scraping' } }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'normal_tool', content: 'Search results for web scraping' }] },
            // Some more conversation
            { role: 'user', content: 'Can you show me an example?' },
            { role: 'assistant', content: 'Here\'s an example of web scraping:' },
            // Orphaned tool_result in the middle of the conversation
            {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'orphaned_middle_tool',
                        content: 'Example code for web scraping',
                    },
                ],
            },
            // More conversation after the orphaned tool_result
            { role: 'assistant', content: 'That\'s how you can scrape websites.' },
            { role: 'user', content: 'Thanks for the explanation' },
        ];

        const result = pruneAndFixConversation(conversation as MessageParam[]);

        // Find the dummy tool_use message that should be inserted before the orphaned tool_result
        const dummyToolUseMessage = result.find(
            (msg) => msg.role === 'assistant'
                && Array.isArray(msg.content)
                && msg.content.some(
                    (block) => block.type === 'tool_use' && block.id === 'orphaned_middle_tool',
                ),
        );

        expect(dummyToolUseMessage).toBeDefined();

        // Check that the dummy tool_use block was created correctly
        expect(dummyToolUseMessage?.content).toContainEqual(
            expect.objectContaining({
                type: 'tool_use',
                id: 'orphaned_middle_tool',
                name: 'unknown_tool',
            }),
        );

        // Verify the order of messages is correct
        const dummyToolUseIndex = result.indexOf(dummyToolUseMessage!);
        const toolResultIndex = result.findIndex(
            (msg) => Array.isArray(msg.content)
                && msg.content.some(
                    (block) => block.type === 'tool_result' && block.tool_use_id === 'orphaned_middle_tool',
                ),
        );

        // Check that the dummy tool_use is IMMEDIATELY before the tool_result (they are chained)
        expect(toolResultIndex).toBe(dummyToolUseIndex + 1);
    });

    it('should NOT add dummy tool_result for tool_use in the last message', () => {
        const conversation = [
            { role: 'user', content: 'scrape example com' },
            { role: 'assistant', content: "I'll help you scrape example.com." },
            // This is the last message with a tool_use, so it should NOT get a dummy tool_result
            { role: 'assistant', content: [{ id: 'last_tool', type: 'tool_use', name: 'scraper', input: { url: 'example.com' } }] },
        ];

        const result = pruneAndFixConversation(conversation as MessageParam[]);

        // Check that no dummy tool_result was added
        const dummyToolResult = result.find(
            (msg) => Array.isArray(msg.content)
            && msg.content.some(
                (block) => block.type === 'tool_result' && block.tool_use_id === 'last_tool',
            ),
        );

        expect(dummyToolResult).toBeUndefined();

        // Check that the result length is the same as the original conversation
        expect(result.length).toBe(conversation.length);
    });

    it('should handle orphaned tool_result before orphaned tool_use', () => {
    // Create random IDs for the test
        const orphanedToolResultId = 'orphaned_tool_result_id';
        const orphanedToolUseId = 'orphaned_tool_use_id';

        const conversation = [
            { role: 'user', content: 'run some tools' },
            { role: 'assistant', content: "I'll run those tools for you." },
            // Orphaned tool_result appears first
            {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: orphanedToolResultId,
                        content: 'Result from orphaned tool',
                    },
                ],
            },
            // Some conversation in between
            { role: 'assistant', content: 'Let me run another tool for you.' },
            // Orphaned tool_use appears later
            {
                role: 'assistant',
                content: [
                    {
                        type: 'tool_use',
                        id: orphanedToolUseId,
                        name: 'unknown_tool',
                        input: {},
                    },
                ],
            },
            { role: 'user', content: 'Thanks for the results' },
        ];

        const result = pruneAndFixConversation(conversation as MessageParam[]);

        // Check that a dummy tool_use was added for the orphaned tool_result
        const dummyToolUseMessage = result.find(
            (msg) => msg.role === 'assistant'
            && Array.isArray(msg.content)
            && msg.content.some(
                (block) => block.type === 'tool_use' && block.id === orphanedToolResultId,
            ),
        );
        expect(dummyToolUseMessage).toBeDefined();

        // Check that a dummy tool_result was added for the orphaned tool_use
        const dummyToolResultMessage = result.find(
            (msg) => msg.role === 'user'
            && Array.isArray(msg.content)
            && msg.content.some(
                (block) => block.type === 'tool_result' && block.tool_use_id === orphanedToolUseId,
            ),
        );
        expect(dummyToolResultMessage).toBeDefined();

        // Verify the order of messages for the orphaned tool_result
        const orphanedToolResultIndex = result.findIndex(
            (msg) => Array.isArray(msg.content)
            && msg.content.some(
                (block) => block.type === 'tool_result' && block.tool_use_id === orphanedToolResultId,
            ),
        );
        const dummyToolUseIndex = result.findIndex(
            (msg) => Array.isArray(msg.content)
            && msg.content.some(
                (block) => block.type === 'tool_use' && block.id === orphanedToolResultId,
            ),
        );
        expect(dummyToolUseIndex).toBe(orphanedToolResultIndex - 1);

        // Verify the order of messages for the orphaned tool_use
        const orphanedToolUseIndex = result.findIndex(
            (msg) => Array.isArray(msg.content)
            && msg.content.some(
                (block) => block.type === 'tool_use' && block.id === orphanedToolUseId,
            ),
        );
        const dummyToolResultIndex = result.findIndex(
            (msg) => Array.isArray(msg.content)
            && msg.content.some(
                (block) => block.type === 'tool_result' && block.tool_use_id === orphanedToolUseId,
            ),
        );
        expect(dummyToolResultIndex).toBe(orphanedToolUseIndex + 1);
    });

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
});
