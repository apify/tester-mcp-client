import type { ContentBlockParam, MessageParam } from '@anthropic-ai/sdk/resources/index.js';

/**
 * Use 'sse' or 'http' for MCP servers that support SSE.
 */
export type McpTransportType = 'sse' | 'http' | 'http-streamable-json-response';

export type Input = {
    llmProviderApiKey: string,
    modelName: string,
    headers: Record<string, string>,
    maxNumberOfToolCallsPerQuery: number,
    modelMaxOutputTokens: number,
    /**
     * @deprecated MCP Use mcpUrl instead
     */
    mcpSseUrl: string,
    mcpUrl: string,
    /**
     * Use 'sse' or 'http'.
     */
    mcpTransportType: McpTransportType,
    systemPrompt: string,
    toolCallTimeoutSec: number,
};

export type StandbyInput = Input & {
    /**
     * @deprecated MCP Use mcpUrl instead
     */
    mcpSseUrl: string,
    mcpUrl: string,
    headers: string | Record<string, string>,
}

export type Tool = {
    name: string;
    description: string | undefined;
    input_schema: unknown;
}

/**
 * A function that charges tokens for a given model.
 * @param inputTokens - The number of input tokens.
 * @param outputTokens - The number of output tokens.
 * @param modelName - The name of the model.
 */
export interface TokenCharger {
    chargeTokens(inputTokens: number, outputTokens: number, modelName: string): Promise<void>;
}

export interface MessageParamWithBlocks extends MessageParam {
    content: ContentBlockParam[];
}
