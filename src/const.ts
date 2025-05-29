import inputSchema from '../.actor/input_schema.json' with { type: 'json' };

export const defaults = {
    mcpUrl: inputSchema.properties.mcpUrl.default,
    systemPrompt: inputSchema.properties.systemPrompt.default,
    modelName: inputSchema.properties.modelName.default,
    modelMaxOutputTokens: inputSchema.properties.modelMaxOutputTokens.default,
    maxNumberOfToolCallsPerQuery: inputSchema.properties.maxNumberOfToolCallsPerQuery.default,
    toolCallTimeoutSec: inputSchema.properties.toolCallTimeoutSec.default,
};

export const MISSING_PARAMETER_ERROR = `Either provide parameter as Actor input or as query parameter: `;

export const BASIC_INFORMATION = 'Once you have the Tester MCP Client running, you can ask:\n'
    + '- "What Apify Actors I can use"\n'
    + '- "Which Actor is the best for scraping Instagram comments"\n'
    + "- \"Can you scrape the first 10 pages of Google search results for 'best restaurants in Prague'?\"\n"
    + '\n';

export const Event = {
    ACTOR_STARTED: 'actor-start',
    ACTOR_RUNNING_TIME: 'actor-running-time',
    INPUT_TOKENS_SONNET_3_7: 'input-tokens-sonnet-3-7',
    OUTPUT_TOKENS_SONNET_3_7: 'output-tokens-sonnet-3-7',
    INPUT_TOKENS_HAIKU_3_5: 'input-tokens-haiku-3-5',
    OUTPUT_TOKENS_HAIKU_3_5: 'output-tokens-haiku-3-5',
    INPUT_TOKENS_SONNET_4: 'input-tokens-sonnet-4',
    OUTPUT_TOKENS_SONNET_4: 'output-tokens-sonnet-4',
    QUERY_ANSWERED: 'query-answered',
};

export const CONVERSATION_RECORD_NAME = 'CONVERSATION';
