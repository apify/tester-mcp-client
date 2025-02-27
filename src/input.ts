import { defaults, MISSING_PARAMETER_ERROR } from './const.js';
import type { Input, StandbyInput } from './types.js';
import { log } from './logger.js';

export let isChargingForQueryAnswered = true;

/**
 * Process input parameters, split actors string into an array
 * @param originalInput
 * @returns input
 */
export function processInput(originalInput: Partial<Input> | Partial<StandbyInput>): Input {
    const input = { ...defaults, ...originalInput } as StandbyInput;

    if (!input.mcpSseUrl) {
        throw new Error(`MCP Server SSE URL is not provided. ${MISSING_PARAMETER_ERROR}: 'mcpSseUrl'`);
    }

    if (!(input.mcpSseUrl.includes('/sse'))) {
        throw new Error(`MCP Server SSE URL is invalid. Provide SSE endpoint with /sse path.`);
    }

    if (!input.headers) {
        input.headers = {};
    }
    if (input.headers && typeof input.headers === 'string') {
        input.headers = JSON.parse(input.headers);
    }
    // Automatically add APIFY_TOKEN to Authorization header (if not present)
    if (typeof input.headers === 'object' && !('Authorization' in input.headers) && process.env.APIFY_TOKEN) {
        input.headers = { ...input.headers, Authorization: `Bearer ${process.env.APIFY_TOKEN}` };
    }

    if (!input.modelName) {
        throw new Error(`LLM model name is not provided. ${MISSING_PARAMETER_ERROR}: 'modelName'`);
    }

    if (input.llmProviderApiKey && input.llmProviderApiKey !== '') {
        log.info('Using user provided API key for LLM provider');
        isChargingForQueryAnswered = false;
    } else {
        log.info('No API key provided for LLM provider, Actor will charge for query answered event');
        input.llmProviderApiKey = process.env.LLM_PROVIDER_API_KEY ?? '';
    }
    return input as Input;
}
