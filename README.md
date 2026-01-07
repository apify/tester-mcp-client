# Tester Client for Model Context Protocol (MCP)

[![Actors MCP Client](https://apify.com/actor-badge?actor=jiri.spilka/tester-mcp-client)](https://apify.com/jiri.spilka/tester-mcp-client)

Implementation of a Model Context Protocol (MCP) client that connects to an MCP server using HTTP streamable transport and ships a modern React UI powered by the AI SDK.
It is a standalone Actor server designed for testing MCP servers over HTTP streamable.
For more information, see the [Model Context Protocol](https://modelcontextprotocol.org/) website or blogpost [What is MCP and why does it matter?](https://blog.apify.com/what-is-model-context-protocol/).

Once you run the Actor, check the output or logs for a link to the chat UI interface to interact with the MCP server.
The URL will look like this and will vary each run:
```shell
Navigate to https://...apify.net to interact with chat-ui interface.
```

## 🚀 Main features

- 🔌 Connects to an MCP server using **HTTP streamable**
- 💬 Provides a modern chat UI with a live tool list and session settings
- 🇦 Connects to an [Apify MCP Server](https://mcp.apify.com) for interacting with one or more Apify Actors
- 💥 Dynamically uses tools based on context and user queries (if supported by a server)
- 🔓 Use Authorization headers and API keys for secure connections
- 🪟 Open source, so you can review it, suggest improvements, or modify it

## 🎯 What does Tester MCP Client do?

When connected to [Apify MCP Server](https://mcp.apify.com/) the Tester MCP Client provides an interactive chat interface where you can:

- "What are the most popular Actors for social media scraping?"
- "Show me the best way to use the Instagram Scraper"
- "Which Actor should I use to extract data from LinkedIn?"
- "Can you help me understand how to scrape Google search results?"

![Tester-MCP-client-screenshot](https://raw.githubusercontent.com/apify/tester-mcp-client/refs/heads/main/docs/chat-ui.png)

## 📖 How does it work?

The Apify MCP Client connects to a running MCP server over **HTTP streamable** and it does the following:

- Initiates a streamable HTTP connection to the MCP server.
- Sends user queries through an AI SDK chat endpoint.
- Receives real-time streamed responses and displays them in the UI.
- Uses MCP tools during generation when needed.
- Shows current tools, settings, and live connection status.

## ⚙️ Usage

- Test any remote MCP server
- Test [Apify MCP Server](https://mcp.apify.com/) and the ability to dynamically select amongst thousands of tools

Learn about the key features and capabilities in the **Apify MCP Server Tutorial: Integrate 5,000+ Apify Actors and Agents Into Claude** video

[Apify MCP Server Tutorial: Integrate 5,000+ Apify Actors and Agents Into Claude](https://www.youtube.com/watch?v=BKu8H91uCTg)

### Normal Mode (on Apify)

You can run the Tester MCP Client on Apify and connect it to any MCP server that supports HTTP streamable.
Configuration can be done via the Apify UI or API by specifying parameters such as the MCP server URL, system prompt, and API key.

Once you run Actor, check the logs for a link to the Tester MCP Client UI, where you can interact with the MCP server:
The URL will look like this and will be different from run to run:
```shell
INFO  Navigate to https://......runs.apify.net in your browser to interact with an MCP server.
```

## 💰 Pricing

You only need an Apify account; the OpenRouter proxy uses your APIFY_TOKEN automatically.

### Supported models

This client uses the Apify OpenRouter proxy, so you can select any OpenRouter model by setting `modelName` to `provider/model`.
Default model: `anthropic/claude-haiku-4.5`.

With the Apify Free tier (no credit card required 💳), you can run the MCP Client for 80 hours per month.
Definitely enough to test your MCP server!

## 📖 How it works

```plaintext
Browser → /api/chat (AI SDK stream) → MCP Client → MCP Server
```
We keep the MCP connection and tool orchestration on the server, while the UI streams responses through the AI SDK chat endpoint.
The AI SDK uses the Apify OpenRouter proxy (`https://openrouter.apify.actor/api/v1`) with your `APIFY_TOKEN`.
SSE endpoints are no longer exposed; the UI streams responses over the AI SDK chat endpoint.
Tool list change notifications are handled by a lightweight MCP SDK client because the AI SDK MCP client does not accept notifications; the AI SDK client is used for chat/tool execution.

1. Navigate to `https://tester-mcp-client.apify.actor?token=YOUR-API-TOKEN` (or http://localhost:3000 if you are running it locally).
2. Built UI assets are served from the `public/` directory.
3. The browser streams chat responses via `POST /api/chat`.
4. Settings are updated via `POST /settings` and applied immediately.


### Local development

The Tester MCP Client Actor is open source and available on [GitHub](https://github.com/apify/tester-mcp-client), allowing you to modify and develop it as needed.

Download the source code:

```bash
git clone https://github.com/apify/tester-mcp-client.git
cd tester-mcp-client
```
Install the dependencies:
```shell
npm install
```

Create a `.env` file with the following content (refer to the `.env.example` file for guidance):

```plaintext
APIFY_TOKEN=YOUR_APIFY_TOKEN
```

Default values for settings such as `mcpUrl`, `systemPrompt`, and others are defined in the `const.ts` file. You can adjust these as needed for your development.

Build the UI and run the client locally:

```bash
npm run build:ui
npm start
```

Navigate to [http://localhost:3000](http://localhost:3000) in your browser to interact with the MCP server.

**Happy chatting with Apify Actors!**

## ⓘ Limitations and feedback

The client does not support all MCP features, such as Prompts and Resource.

## References

- [Model Context Protocol](https://modelcontextprotocol.org/)
- [Apify MCP Server](https://mcp.apify.com)
- [Apify MCP Server](https://docs.apify.com/platform/integrations/mcp)
- [What are AI Agents?](https://blog.apify.com/what-are-ai-agents/)
- [What is MCP and why does it matter?](https://blog.apify.com/what-is-model-context-protocol/)
- [How to use MCP with Apify Actors](https://blog.apify.com/how-to-use-mcp/)
- [Apify MCP Server Tutorial: Integrate 5,000+ Apify Actors and Agents Into Claude](https://www.youtube.com/watch?v=BKu8H91uCTg&ab_channel=Apify)
