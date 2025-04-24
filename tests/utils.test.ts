import type { MessageParam } from '@anthropic-ai/sdk/resources/index.js';
import { describe, it, expect } from 'vitest';

import { pruneAndFixConversation } from '../src/utils.js';

describe('pruneAndFixConversation', () => {
    it('should add missing tool_result blocks for tool_use messages', () => {
        const conversation = [
            { role: 'user', content: 'scrape example com' },
            { role: 'assistant', content: "I'll help you scrape example.com." },
            { role: 'assistant', content: [{ id: 'tool_1', type: 'tool_use' }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: '[Tool use failed]' }] },
            { role: 'assistant', content: [{ id: 'tool_2', type: 'tool_use' }] },
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
});
