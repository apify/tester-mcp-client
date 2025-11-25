import { defaults, deprecatedModels, MISSING_PARAMETER_ERROR } from './const.js';
import { log } from './logger.js';
import type { Input, StandbyInput } from './types.js';

let isChargingForTokens = true;

export function getChargeForTokens() {
    return isChargingForTokens;
}

/**
 * Process input parameters, split actors string into an array
 * @param originalInput
 * @returns input
 */
export function processInput(originalInput: Partial<Input> | Partial<StandbyInput>): Input {
    // Normalize deprecated transport type before casting
    let { mcpTransportType } = originalInput;
    if (mcpTransportType === 'http-streamable-json-response') {
        mcpTransportType = 'http';
    }

    const input = { ...defaults, ...originalInput, mcpTransportType } as StandbyInput;

    // MCP SSE URL is deprecated, use MCP URL instead
    if (input.mcpSseUrl && !input.mcpUrl) {
        input.mcpUrl = input.mcpSseUrl;
    }
    if (!input.mcpUrl) {
        throw new Error(`MCP Server URL is not provided. ${MISSING_PARAMETER_ERROR}: 'mcpUrl'`);
    }

    if (input.mcpTransportType === 'http' && input.mcpUrl.includes('/sse')) {
        throw new Error(`MCP URL includes /sse path, but the transport is set to 'http'. This is very likely a mistake.`);
    }

    if (input.mcpUrl.includes('/sse')) {
        input.mcpTransportType = 'sse';
    } else {
        input.mcpTransportType = 'http';
    }

    if (!input.headers) {
        input.headers = {};
    }
    if (input.headers && typeof input.headers === 'string') {
        try {
            input.headers = JSON.parse(input.headers);
        } catch (error) {
            throw new Error(`Invalid JSON string in headers: ${(error as Error).message}`);
        }
    }
    // Automatically add APIFY_TOKEN to Authorization header (if not present)
    if (typeof input.headers === 'object' && !('Authorization' in input.headers) && process.env.APIFY_TOKEN) {
        input.headers = { ...input.headers, Authorization: `Bearer ${process.env.APIFY_TOKEN}` };
    }

    if (!input.modelName) {
        throw new Error(`LLM model name is not provided. ${MISSING_PARAMETER_ERROR}: 'modelName'`);
    }

    if (deprecatedModels[input.modelName]) {
        log.warning(`The model "${input.modelName}" is deprecated and will be removed in future versions. Using ${deprecatedModels[input.modelName]} instead.`);
        input.modelName = deprecatedModels[input.modelName];
    }

    if (input.llmProviderApiKey && input.llmProviderApiKey !== '') {
        log.info('Using user provided API key for an LLM provider');
        isChargingForTokens = false;
    } else {
        log.info('No API key provided for an LLM provider, Actor will charge for tokens usage');
        input.llmProviderApiKey = process.env.LLM_PROVIDER_API_KEY ?? '';
    }

    if (input.telemetry) {
        log.info('Telemetry is enabled, all data will be saved to improve the MCP tools. Can be disabled by setting "telemetry" to false in the input.');
    }
    // update system prompt with current date and time
    const currentDate = new Date().toUTCString();
    input.systemPrompt += `\nCurrent date and UTC time ${currentDate}`;
    return input as Input;
}
