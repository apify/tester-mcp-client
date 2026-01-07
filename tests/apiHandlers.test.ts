import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';

import {
    createSchemaModelsHandler,
    createSettingsHandlers,
    createToolsHandlers,
    type RuntimeSettings,
} from '../src/apiHandlers.js';

const waitForTasks = async () => {
    await new Promise<void>((resolve) => {
        setImmediate(resolve);
    });
};

const createMockRes = () => {
    let statusCode = 200;
    let payload: unknown = null;
    const res = {
        status(code: number) {
            statusCode = code;
            return res;
        },
        json(data: unknown) {
            payload = data;
            return res;
        },
        get statusCode() {
            return statusCode;
        },
        get body() {
            return payload;
        },
    };
    return res as Response & { body: unknown };
};

const next = () => {};

describe('apiHandlers', () => {
    it('schema/models falls back to anthropic/claude-haiku-4.5 when no enum', async () => {
        const handler = createSchemaModelsHandler({});
        const res = createMockRes();
        handler({} as Request, res, next);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual([{ value: 'anthropic/claude-haiku-4.5', label: 'anthropic/claude-haiku-4.5' }]);
    });

    it('settings handlers validate and update runtime settings', async () => {
        let runtimeSettings: RuntimeSettings = {
            mcpUrl: 'https://mcp.apify.com',
            mcpTransportType: 'http',
            systemPrompt: 'hello',
            modelName: 'anthropic/claude-haiku-4.5',
            modelMaxOutputTokens: 1000,
            maxNumberOfToolCallsPerQuery: 3,
            toolCallTimeoutSec: 200,
        };
        const defaultSettings = { ...runtimeSettings };
        let updatedCalled = false;

        const handlers = createSettingsHandlers({
            getRuntimeSettings: () => runtimeSettings,
            setRuntimeSettings: (nextSettings) => {
                runtimeSettings = nextSettings;
            },
            defaultSettings,
            onSettingsUpdated: () => {
                updatedCalled = true;
            },
        });

        const invalidRes = createMockRes();
        handlers.updateSettings({ body: { mcpUrl: '' } } as Request, invalidRes, next);
        expect(invalidRes.statusCode).toBe(400);

        const updateRes = createMockRes();
        handlers.updateSettings({ body: { modelName: 'openrouter/gpt-4o-mini' } } as Request, updateRes, next);
        await waitForTasks();
        expect(updateRes.statusCode).toBe(200);
        expect(updateRes.body).toEqual({ success: true });
        expect(runtimeSettings.modelName).toBe('openrouter/gpt-4o-mini');
        expect(updatedCalled).toBe(true);

        const resetRes = createMockRes();
        handlers.resetSettings({} as Request, resetRes, next);
        await waitForTasks();
        expect(resetRes.statusCode).toBe(200);
        expect(runtimeSettings).toEqual(defaultSettings);
    });

    it('tools handlers return cached tools for api/tools and available-tools', async () => {
        const cache = [
            { name: 'apify.tool', description: 'desc', title: 'Tool title', input_schema: { type: 'object' } },
        ];
        const handlers = createToolsHandlers({
            getToolsCache: () => cache,
        });

        const availableRes = createMockRes();
        handlers.availableTools({} as Request, availableRes, next);
        await waitForTasks();
        expect(availableRes.statusCode).toBe(200);
        expect(availableRes.body).toEqual({ tools: cache });

        const apiToolsRes = createMockRes();
        handlers.apiTools({} as Request, apiToolsRes, next);
        await waitForTasks();
        expect(apiToolsRes.statusCode).toBe(200);
        expect(apiToolsRes.body).toEqual({
            tools: [{ name: 'apify.tool', title: 'Tool title', description: 'desc' }],
        });
    });
});
