import type { RequestHandler } from 'express';

import type { McpTransportType } from './types.js';

export type RuntimeSettings = {
    mcpUrl: string;
    mcpTransportType: McpTransportType;
    systemPrompt: string;
    modelName: string;
    modelMaxOutputTokens: number;
    maxNumberOfToolCallsPerQuery: number;
    toolCallTimeoutSec: number;
};

type SettingsDependencies = {
    getRuntimeSettings: () => RuntimeSettings;
    setRuntimeSettings: (settings: RuntimeSettings) => void;
    defaultSettings: RuntimeSettings;
    onSettingsUpdated?: (next: RuntimeSettings, patch: Partial<RuntimeSettings>) => Promise<void> | void;
};

export const createSettingsHandlers = ({
    getRuntimeSettings,
    setRuntimeSettings,
    defaultSettings,
    onSettingsUpdated,
}: SettingsDependencies) => {
    const getSettings: RequestHandler = (_req, res) => {
        res.json(getRuntimeSettings());
    };

    const updateSettings: RequestHandler = (req, res) => {
        const patch = req.body ?? {};
        if (patch.mcpUrl !== undefined && !patch.mcpUrl) {
            res.status(400).json({ success: false, error: 'MCP URL is required' });
            return;
        }
        if (patch.modelName !== undefined && !patch.modelName) {
            res.status(400).json({ success: false, error: 'Model name is required' });
            return;
        }
        const next = { ...getRuntimeSettings(), ...patch };
        setRuntimeSettings(next);
        const commitUpdate = async () => {
            if (onSettingsUpdated) {
                await onSettingsUpdated(next, patch);
            }
            res.json({ success: true });
        };
        commitUpdate().catch((error) => {
            const message = error instanceof Error ? error.message : 'Failed to update settings';
            res.status(500).json({ success: false, error: message });
        });
    };

    const resetSettings: RequestHandler = (_req, res) => {
        setRuntimeSettings(defaultSettings);
        const commitReset = async () => {
            if (onSettingsUpdated) {
                await onSettingsUpdated(defaultSettings, {});
            }
            res.json({ success: true });
        };
        commitReset().catch((error) => {
            const message = error instanceof Error ? error.message : 'Failed to reset settings';
            res.status(500).json({ success: false, error: message });
        });
    };

    return { getSettings, updateSettings, resetSettings };
};

export const createSchemaModelsHandler = (modelProperty: { enum?: string[]; enumTitles?: string[] }): RequestHandler => {
    return (_req, res) => {
        const models = modelProperty.enum ?? ['anthropic/claude-haiku-4.5'];
        const titles = modelProperty.enumTitles ?? models;
        const modelOptions = models.map((model, index) => ({
            value: model,
            label: titles[index] ?? model,
        }));
        res.json(modelOptions);
    };
};

type ToolsDependencies = {
    getToolsCache: () => { name: string; description?: string; input_schema?: unknown; title?: string }[];
    ensureToolsCache?: () => Promise<void> | void;
    onError?: (error: Error) => void;
};

export const createToolsHandlers = ({
    getToolsCache,
    ensureToolsCache,
    onError,
}: ToolsDependencies) => {
    const availableTools: RequestHandler = (_req, res) => {
        const sendResponse = async () => {
            if (ensureToolsCache) {
                await ensureToolsCache();
            }
            res.json({ tools: getToolsCache() });
        };
        sendResponse().catch((error) => {
            if (error instanceof Error) {
                onError?.(error);
            }
            res.status(500).json({ error: 'Failed to fetch tools' });
        });
    };

    const apiTools: RequestHandler = (_req, res) => {
        const sendResponse = async () => {
            if (ensureToolsCache) {
                await ensureToolsCache();
            }
            const tools = getToolsCache().map((tool) => ({
                name: tool.name,
                title: tool.title ?? tool.name,
                description: tool.description,
            }));
            res.json({ tools });
        };
        sendResponse().catch((error) => {
            if (error instanceof Error) {
                onError?.(error);
            }
            res.status(500).json({ error: 'Failed to fetch tools', tools: [] });
        });
    };

    return { availableTools, apiTools };
};
