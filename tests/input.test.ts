import { describe, it, expect } from 'vitest';

import { processInput } from '../src/input.js';
import type { StandbyInput } from '../src/types.js';

describe('processInput', () => {
    it('should convert http-streamable-json-response to http-streamable', () => {
        const input = {
            mcpUrl: 'https://mcp.apify.com',
            mcpTransportType: 'http-streamable-json-response',
            modelName: 'claude-3-5-haiku-latest',
        } as unknown as Partial<StandbyInput>;
        const result = processInput(input);
        expect(result.mcpTransportType).toBe('http-streamable');
    });

    it('should keep http-streamable as is', () => {
        const input: Partial<StandbyInput> = {
            mcpUrl: 'https://mcp.apify.com',
            mcpTransportType: 'http-streamable',
            modelName: 'claude-3-5-haiku-latest',
        };

        const result = processInput(input);

        expect(result.mcpTransportType).toBe('http-streamable');
    });

    it('should set mcpTransportType to http-streamable if mcpUrl does not include /sse', () => {
        const input: Partial<StandbyInput> = {
            mcpUrl: 'https://mcp.apify.com',
            modelName: 'claude-3-5-haiku-latest',
        };

        const result = processInput(input);

        expect(result.mcpTransportType).toBe('http-streamable');
    });

    it('should set mcpTransportType to sse if mcpUrl includes /sse', () => {
        const input: Partial<StandbyInput> = {
            mcpUrl: 'https://mcp.apify.com/sse',
            modelName: 'claude-3-5-haiku-latest',
        };

        const result = processInput(input);

        expect(result.mcpTransportType).toBe('sse');
    });

    it('should throw an error if mcpTransportType is http-streamable but mcpUrl includes /sse', () => {
        const input: Partial<StandbyInput> = {
            mcpUrl: 'https://mcp.apify.com/sse',
            mcpTransportType: 'http-streamable',
            modelName: 'claude-3-5-haiku-latest',
        };

        expect(() => processInput(input)).toThrow();
    });
});
