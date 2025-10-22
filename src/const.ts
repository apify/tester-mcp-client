import inputSchema from '../.actor/input_schema.json' with { type: 'json' };

export const defaults = {
    mcpUrl: inputSchema.properties.mcpUrl.default,
    systemPrompt: inputSchema.properties.systemPrompt.default,
    modelName: inputSchema.properties.modelName.default,
    modelMaxOutputTokens: inputSchema.properties.modelMaxOutputTokens.default,
    maxNumberOfToolCallsPerQuery: inputSchema.properties.maxNumberOfToolCallsPerQuery.default,
    toolCallTimeoutSec: inputSchema.properties.toolCallTimeoutSec.default,
};

export const deprecatedModels: Record<string, string> = {
    'claude-sonnet-4-0': 'claude-sonnet-4-5-20250929',
    'claude-3-7-sonnet-latest': 'claude-sonnet-4-5-20250929',
    'claude-3-5-haiku-latest': 'claude-haiku-4-5-20251001',
};

export const MISSING_PARAMETER_ERROR = `Either provide parameter as Actor input or as query parameter: `;

export const BASIC_INFORMATION = 'Once you have the Tester MCP Client running, you can ask:\n'
    + '- "What Apify Actors I can use"\n'
    + '- "Which Actor is the best for scraping Instagram comments"\n'
    + "- \"Can you scrape the first 10 pages of Google search results for 'best restaurants in Prague'?\"\n"
    + '\n';

export const Event = {
    ACTOR_RUNNING_TIME: 'actor-running-time',
    INPUT_TOKENS_HAIKU: 'input-tokens-haiku',
    OUTPUT_TOKENS_HAIKU: 'output-tokens-haiku',
    INPUT_TOKENS_SONNET: 'input-tokens-sonnet',
    OUTPUT_TOKENS_SONNET: 'output-tokens-sonnet',
    QUERY_ANSWERED: 'query-answered',
};

export const CONVERSATION_RECORD_NAME = 'CONVERSATION';

export const IMAGE_BASE64_PLACEHOLDER = '[Base64 encoded content - image was pruned to save context tokens]';

export const TELEMETRY_SERVICE_NAME = 'mcp-client';
