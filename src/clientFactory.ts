// clientFactory.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema, LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { LoggingMessageNotification, ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import { log } from 'apify';

/**
 * Create a client for the MCP server
 * @param serverUrl - The URL of the MCP server
 * @param mcpTransport - The transport method to use for the MCP server. Either 'sse' or 'http-streamable-json-response'
 * @param customHeaders - Custom headers to send to the MCP server
 * @param onToolsUpdate - A function to call when the tools list changes. Used to update the tools in the conversation manager
 * @param onNotification - A function to call when a notification is received. Used to log notifications
 * @returns A client for the MCP server
 */
export async function createClient(
    serverUrl: string,
    mcpTransport: 'sse' | 'http-streamable-json-response',
    customHeaders: Record<string, string> | null,
    onToolsUpdate: (listTools: ListToolsResult) => Promise<void>,
    onNotification: (notification: LoggingMessageNotification) => void,
): Promise<Client> {
    const client = new Client(
        { name: 'example-client', version: '1.0.0' },
        { capabilities: {} },
    );

    let transport;
    if (mcpTransport === 'sse') {
        transport = new SSEClientTransport(
            new URL(serverUrl),
            {
                requestInit: { headers: customHeaders || undefined },
                eventSourceInit: {
                    // The EventSource package augments EventSourceInit with a "fetch" parameter.
                    // You can use this to set additional headers on the outgoing request.
                    // Based on this example: https://github.com/modelcontextprotocol/typescript-sdk/issues/118
                    async fetch(input: Request | URL | string, init?: RequestInit) {
                        const headers = new Headers({ ...(init?.headers || {}), ...customHeaders });
                        return fetch(input, { ...init, headers });
                    },
                    // We have to cast to "any" to use it, since it's non-standard
                } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
            },
        );
    } else {
        transport = new StreamableHTTPClientTransport(
            new URL(serverUrl),
            { requestInit: { headers: customHeaders || undefined } },
        );
    }

    try {
        await client.connect(transport);
        await onToolsUpdate(await client.listTools());
        log.debug(`Connection ${mcpTransport} to MCP server: ${serverUrl} established`);
    } catch (error) {
        log.error(`Failed to connect to MCP server: ${serverUrl}`, { error });
        throw new Error(`Failed to connect to MCP server: ${serverUrl}`);
    }

    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
        log.debug(`Notification received: ${notification.params.level} - ${notification.params.data}`);
        onNotification(notification);
    });

    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        log.debug('Received notification that tools list changed, refreshing...');
        await onToolsUpdate(await client.listTools());
    });
    return client;
}
