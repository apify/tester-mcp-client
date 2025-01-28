# Tester Client for Model Context Protocol (MCP)

[![Actors MCP Client](https://apify.com/actor-badge?actor=jiri.spilka/tester-mcp-client)](https://apify.com/jiri.spilka/tester-mcp-client)

Implementation of a model context protocol (MCP) client that connects to an MCP server using Server-Sent Events (SSE) and displays the conversation in a chat-like UI.
It is a standalone Actor server designed for testing MCP servers over SSE.

## 🚀 Main features

- 🔌 Connects to an MCP server using Server-Sent Events (SSE)
- 💬 Provides a chat-like UI for displaying tool calls and results
- 🇦 Connects to an [Apify MCP Server](https://apify.com/apify/actors-mcp-server) for interacting with one or more Apify Actors
- 💥 Dynamically loads and utilizes tools based on context and user queries (only if supported by the server)
- 🔓 Use Authorization headers and API keys for secure connections
- 🪟 Open source, so you can review it, suggest improvements, or modify it

# 🎯 What does Tester MCP Client do?

The Apify MCP Client connects to a running MCP server over Server-Sent Events (SSE) and it does the following:

- Initiates an SSE connection to the MCP server `/sse`.
- Sends user queries to the MCP server via `POST /message`.
- Receives real-time streamed responses (via `GET /sse`) that may include LLM output, and **tool usage** blocks
- Based on the LLM response, orchestrates tool calls and displays the conversation
- Displays the conversation


## How it works

```plaintext
Browser ← (SSE) → Tester MCP Clinent  ← (SSE) → MCP Server
```
We create this chain to keep any custom bridging logic inside the Tester MCP Client, while leaving the main MCP Server unchanged.
The browser uses SSE to communicate with the Tester MCP Client, and the Tester MCP Client relies on SSE to talk to the MCP Server.
This separates extra client-side logic from the core server, making it easier to maintain and debug.

1. Navigate to `https://tester-mcp-client.apify.actor?token=YOUR-API-TOKEN` (or http://localhost:3000 if you are running it locally).
2. Files `index.html` and `client.js` are served from the `public/` directory.
3. Browser opens SSE stream via `GET /sse`.
4. The user’s query is sent with `POST /message`.
5. Query processing:
    - Calls Large Language Model.
    - Optionally calls tools if required using
6. For each result chunk, `sseEmit(role, content)`

# ⚙️ Usage

Once you have the Tester MCP Client running, you can ask:
- "What Apify Actors I can use"
- "Which Actor is the best for scraping Instagram comments"
- "Can you scrape the first 10 pages of Google search results for 'best restaurants in Prague'?"

## Standby Mode (on Apify)

- Test any MCP server over SSE with a standalone client running on Apify
- Test [Apify Actors MCP Server](https://apify.com/apify/actors-mcp-server) and ability to dynamically select amongst 3000+ tools
- Request data from a remote Apify Actor (e.g., [Google Maps with contact details](https://apify.com/lukaskrivka/google-maps-with-contact-details)).

### Pricing

The Apify MCP Client is free to use. You only pay for the resources you consume on the Apify platform.

Running the MCP Client for 1 hour costs approximately $0.06.
With the Apify Free tier (no credit card required 💳), you can run the MCP Client for 80 hours per month.
Definitely enough to test your MCP server!

## Local development

The Tester MCP Client Actor is open source and available on [GitHub](https://github.com/apify/rag-web-browser), allowing you to modify and develop it as needed.

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
LLM_PROVIDER_API_KEY=YOUR_API_KEY
```

Default values for settings such as `mcpServerUrl`, `systemPrompt`, and others are defined in the `const.ts` file. You can adjust these as needed for your development.

Run the client locally

```bash
npm start
```

Navigate to [http://localhost:3000](http://localhost:3000) in your browser to interact with the MCP server.

**Happy chatting with Apify Actors!**

# ⓘ Limitations and feedback

The client does not support all MCP features, such as Prompts and Resource.
Also, it does not store the conversation, so refreshing the page will clear the chat history.
