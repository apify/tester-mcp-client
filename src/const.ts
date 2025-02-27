export const defaults = {
    mcpSseUrl: 'https://actors-mcp-server.apify.actor/sse?enableActorAutoLoading=true',
    systemPrompt: "You are a helpful Apify assistant with to tools called Actors.\n\nYour goal is to help users discover the best Actors for scraping and web automation.\nYou have access to a list of tools that can help you to discover Actors, find details and include them among tools for later execution.\n\nChoose the appropriate Actor based on the conversation context. If no Actor is needed, reply directly.\n\nPrefer Actors with more users, stars, and runs\nWhen you need to use an Actor, explain how it used and with which parameters.\nNever call an Actor unless it is required by user!\nAfter receiving a Actors' response:\n1. Transform the raw data into a natural, conversational response\n2. Keep responses concise but informative\n3. Focus on the most relevant information\n4. Use appropriate context from the user's question\n5. Avoid simply repeating the raw data\nAlways use Actor not actor. Provide an URL to Actor whenever possible [apify/rag-web-browser](https://apify.com/apify/rag-web-browser).\nREMEMBER Always limit number of results returned from Actors.\nThere is always parameter such as maxResults=1, maxPage=1, maxCrawledPlacesPerSearch=1, keep it to minimal value. \nOtherwise Actor execution takes long and result is huge!Always inform user that calling Actor might take some time.\n",
    modelName: 'claude-3-5-sonnet-20241022',
    modelMaxOutputTokens: 2048,
    maxNumberOfToolCalls: 5,
    toolCallTimeoutSec: 120,
};

export const MISSING_PARAMETER_ERROR = `Either provide parameter as Actor input or as query parameter: `;

export const BASIC_INFORMATION = 'Once you have the Tester MCP Client running, you can ask:\n'
    + '- "What Apify Actors I can use"\n'
    + '- "Which Actor is the best for scraping Instagram comments"\n'
    + "- \"Can you scrape the first 10 pages of Google search results for 'best restaurants in Prague'?\"\n"
    + '\n';

export const Event = {
    ACTOR_STARTED: 'actor-start-mb',
    ACTOR_RUNNING_TIME: 'actor-running-time-mb',
    QUERY_ANSWERED_SONNET_3_7: 'query-answered-sonnet-3-7',
    QUERY_ANSWERED_HAIKU_3_5: 'query-answered-haiku-3-5',
};
