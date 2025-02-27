export type Input = {
    llmProviderApiKey: string,
    modelName: string,
    headers: Record<string, string>,
    maxNumberOfToolCallsPerQuery: number,
    modelMaxOutputTokens: number,
    mcpSseUrl: string,
    systemPrompt: string,
    toolCallTimeoutSec: number,
};

export type StandbyInput = Input & {
    mcpSseUrl: string,
    headers: string | Record<string, string>,
}
