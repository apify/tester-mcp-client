/* eslint-disable no-console */
// client.js

// ================== DOM ELEMENTS & GLOBAL STATE ==================
const chatLog = document.getElementById('chatLog');
const clearBtn = document.getElementById('clearBtn');
const clientInfo = document.getElementById('clientInfo');
const information = document.getElementById('information');
const mcpUrl = document.getElementById('mcpSseUrl');
const queryInput = document.getElementById('queryInput');
const sendBtn = document.getElementById('sendBtn');
const pingMcpServerBtn = document.getElementById('pingMcpServerBtn');

// Simple scroll to bottom function
function scrollToBottom() {
    // Scroll the chat log
    chatLog.scrollTop = chatLog.scrollHeight;

    // Also scroll the window to ensure we're at the bottom
    window.scrollTo(0, document.body.scrollHeight);
}

const messages = []; // Local message array for display only
const actorTimeoutCheckDelay = 60_000; // 60 seconds between checks
let timeoutCheckInterval = null; // Will store the interval ID
const sseReconnectDelay = 10_000; // 10 seconds before reconnecting

// ================== SSE CONNECTION SETUP ==================
let eventSource = new EventSource('/sse');

// Function to handle incoming SSE messages
function handleSSEMessage(event) {
    let data;
    try {
        data = JSON.parse(event.data);
    } catch {
        console.warn('Could not parse SSE event as JSON:', event.data);
        return;
    }
    appendMessage(data.role, data.content);
}

// Function to handle SSE errors
function handleSSEError(err) {
    console.error('SSE error:', err);
    const errorMessage = err instanceof Error ? err.message : 'Connection lost from Browser to MCP-tester-client server. Attempting to reconnect...';
    console.log(errorMessage);
    appendMessage('internal', errorMessage);

    // Close the current connection
    eventSource.close();

    // Attempt to reconnect after a delay
    setTimeout(reconnectSSE, sseReconnectDelay);
}

eventSource.onmessage = handleSSEMessage;
eventSource.onerror = handleSSEError;

function reconnectSSE() {
    const newEventSource = new EventSource('/sse');

    newEventSource.onopen = () => {
        appendMessage('internal', 'Connection restored!');
        eventSource = newEventSource; // Update the global eventSource reference

        // Reattach message and error handlers
        eventSource.onmessage = handleSSEMessage;
        eventSource.onerror = handleSSEError;
    };

    newEventSource.onerror = handleSSEError; // Reuse the same error handler
}

// ================== ON PAGE LOAD (DOMContentLoaded) ==================
//  - Fetch client info
//  - Set up everything else

// Initial connection on a page load
document.addEventListener('DOMContentLoaded', async () => {
    // Fetch client info first
    try {
        const resp = await fetch('/client-info');
        const data = await resp.json();
        if (mcpUrl) mcpUrl.textContent = data.mcpUrl;
        if (clientInfo) clientInfo.textContent = `Model name: ${data.modelName}\nSystem prompt: ${data.systemPrompt}`;
        if (information) information.innerHTML = `${data.information}`;
    } catch (err) {
        console.error('Error fetching client info:', err);
    }

    // Add this near the DOMContentLoaded event listener
    window.addEventListener('beforeunload', async () => {
        // Note: Most modern browsers require the event to be handled synchronously
        // and don't allow async operations during beforeunload
        try {
            // Synchronous fetch using XMLHttpRequest
            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/conversation/reset', false); // false makes it synchronous
            xhr.send();

            messages.length = 0;
            chatLog.innerHTML = '';
        } catch (err) {
            console.error('Error resetting conversation on page reload:', err);
        }
    });

    // Call ping on a page load
    await pingMcpServer();
});

// ================== MAIN CHAT LOGIC: APPEND MESSAGES & TOOL BLOCKS ==================

/**
 * appendMessage(role, content):
 *   If content is an array (potential tool blocks),
 *   handle each item separately; otherwise just show a normal bubble.
 */
function appendMessage(role, content) {
    messages.push({ role, content });

    if (Array.isArray(content)) {
        content.forEach((item) => {
            if (item.type === 'tool_use' || item.type === 'tool_result') {
                appendToolBlock(item);
            } else {
                appendSingleBubble(role, item);
            }
        });
    } else {
        // normal single content
        appendSingleBubble(role, content);
    }
}

/**
 * appendSingleBubble(role, content): Renders a normal user/assistant/internal bubble
 */
function appendSingleBubble(role, content) {
    const row = document.createElement('div');
    row.className = 'message-row';

    if (role === 'user') {
        row.classList.add('user-message');
    } else if (role === 'assistant') {
        row.classList.add('assistant-message');
    } else {
        row.classList.add('internal-message');
    }

    const bubble = document.createElement('div');
    bubble.className = `bubble ${role}`;
    bubble.innerHTML = formatAnyContent(content);

    row.appendChild(bubble);
    chatLog.appendChild(row);
    scrollToBottom();
}

/**
 * appendToolBlock(item): Renders a separate row for tool_use/tool_result
 */
function appendToolBlock(item) {
    const row = document.createElement('div');
    row.className = 'message-row tool-row';

    const container = document.createElement('div');
    container.className = 'tool-block';

    if (item.type === 'tool_use') {
        const inputContent = item.input ? formatAnyContent(item.input) : '<em>No input provided</em>';
        container.innerHTML = `
<details class="tool-details">
  <summary>
    <div class="tool-header">
      <div class="tool-icon">
        <i class="fas fa-tools"></i>
      </div>
      <div class="tool-info">
        <div class="tool-name">${item.name || 'Unknown Tool'}</div>
        <div class="tool-id">ID: ${item.id || 'unknown'}</div>
      </div>
      <div class="tool-status">
        <i class="fas fa-chevron-down"></i>
      </div>
    </div>
  </summary>
  <div class="tool-content">
    <div class="tool-input">
      <div class="tool-label">Input:</div>
      ${inputContent}
    </div>
  </div>
</details>`;
    } else if (item.type === 'tool_result') {
        const resultContent = item.content ? formatAnyContent(item.content) : '<em>No result available</em>';
        container.innerHTML = `
<details class="tool-details">
  <summary>
    <div class="tool-header">
      <div class="tool-icon">
        <i class="fas fa-code-branch"></i>
      </div>
      <div class="tool-info">
        <div class="tool-name">Tool Result</div>
      </div>
      <div class="tool-status">
        <i class="fas fa-chevron-down"></i>
      </div>
    </div>
  </summary>
  <div class="tool-content">
    <div class="tool-result">
      <div class="tool-label">${item.is_error ? 'Error Details:' : 'Result:'}</div>
      ${resultContent}
    </div>
  </div>
</details>`;
    }

    row.appendChild(container);
    chatLog.appendChild(row);
    scrollToBottom();

    // Add click handler for the chevron icon
    const chevron = container.querySelector('.fa-chevron-down');
    if (chevron) {
        const details = container.querySelector('details');
        details.addEventListener('toggle', () => {
            chevron.style.transform = details.open ? 'rotate(180deg)' : 'rotate(0deg)';
        });
    }
}

// ================== UTILITY FOR FORMATTING CONTENT (JSON, MD, ETC.) ==================
function formatAnyContent(content) {
    if (typeof content === 'string') {
        // Try JSON parse
        try {
            const obj = JSON.parse(content);
            return `<pre>${escapeHTML(JSON.stringify(obj, null, 2))}</pre>`;
        } catch {
            // fallback to markdown
            return formatMarkdown(content);
        }
    }

    if (content && typeof content === 'object') {
        // plain object → JSON
        return `<pre>${escapeHTML(JSON.stringify(content, null, 2))}</pre>`;
    }

    // fallback
    return String(content);
}

/** A naive Markdown transform */
function formatMarkdown(text) {
    let safe = escapeHTML(text);
    // code fences
    safe = safe.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
    // inline code
    safe = safe.replace(/`([^`]+)`/g, '<code>$1</code>');
    // bold, italics, links, newlines
    safe = safe.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    safe = safe.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    safe = safe.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    safe = safe.replace(/\n/g, '<br>');
    return safe;
}

/** HTML escaper for <pre> blocks, etc. */
function escapeHTML(str) {
    if (typeof str !== 'string') return String(str);
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ================== SENDING A USER QUERY (POST /message) ==================
async function sendQuery(query) {
    // First append the user message
    appendMessage('user', query);

    // Create and show typing indicator
    const loadingRow = document.createElement('div');
    loadingRow.className = 'message-row';
    loadingRow.innerHTML = `
        <div class="bubble assistant loading">
            <div class="typing-indicator">
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
            </div>
        </div>
    `;

    chatLog.appendChild(loadingRow);
    scrollToBottom();

    try {
        const resp = await fetch('/message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query }),
        });
        const data = await resp.json();
        if (data.error) {
            appendMessage('internal', `Server error: ${data.error}`);
        }
    } catch (err) {
        appendMessage('internal', `Network error: ${err.message}`);
    } finally {
        // Remove loading indicator
        if (loadingRow.parentNode === chatLog) {
            loadingRow.remove();
        }
    }
}

// ================== CLEAR CONVERSATION LOG (POST /conversation/reset) ==================
clearBtn.addEventListener('click', async () => {
    try {
        // Add visual feedback
        clearBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        clearBtn.disabled = true;

        messages.length = 0;
        chatLog.innerHTML = '';

        const resp = await fetch('/conversation/reset', { method: 'POST' });
        const data = await resp.json();

        if (data.error) {
            console.error('Server error when resetting conversation:', data.error);
            appendMessage('internal', 'Failed to clear conversation. Please try again.');
        } else {
            console.log('Server conversation reset');
            appendMessage('internal', 'Conversation cleared successfully.');
        }
    } catch (err) {
        console.error('Error resetting conversation:', err);
        appendMessage('internal', 'Error clearing conversation. Please try again.');
    } finally {
        // Reset button state
        clearBtn.innerHTML = '<i class="fas fa-trash"></i>';
        clearBtn.disabled = false;
    }
});

// Add this new function near other utility functions
async function checkActorTimeout() {
    try {
        const response = await fetch('/check-actor-timeout');
        const data = await response.json();

        if (data.timeoutImminent) {
            const secondsLeft = Math.ceil(data.timeUntilTimeout / 1000);
            if (secondsLeft <= 0) {
                appendMessage('internal', '⚠️ Actor has timed out and stopped running. Please restart the Actor to continue.');
                // Clear the interval when timeout is detected
                if (timeoutCheckInterval) {
                    clearInterval(timeoutCheckInterval);
                    timeoutCheckInterval = null;
                }
            } else {
                appendMessage('internal', `⚠️ Actor will timeout in ${secondsLeft} seconds.\n`);
            }
        }
    } catch (err) {
        console.error('Error checking timeout status:', err);
    }
}

// Store the interval ID when creating it
timeoutCheckInterval = setInterval(async () => {
    await checkActorTimeout();
}, actorTimeoutCheckDelay);

// ================== SEND BUTTON, ENTER KEY HANDLER ==================
sendBtn.addEventListener('click', () => {
    const query = queryInput.value.trim();
    if (query) {
        sendQuery(query);
        queryInput.value = '';
    }
});

queryInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        sendBtn.click();
    }
});

// Add ping function
async function pingMcpServer() {
    try {
        const resp = await fetch('/ping-mcp-server');
        const data = await resp.json();
        if (data.status === true || data.status === 'OK') {
            appendMessage('internal', 'Successfully connected to MCP server');
        } else {
            appendMessage('internal', 'Failed to connect to MCP server');
        }
    } catch (err) {
        appendMessage('internal', `Error pinging MCP server: ${err.message}`);
    }
}

// Add click handler for reconnect button
pingMcpServerBtn.addEventListener('click', async () => {
    try {
        // Add visual feedback
        pingMcpServerBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        pingMcpServerBtn.disabled = true;

        await pingMcpServer();
    } finally {
        // Reset button state
        pingMcpServerBtn.innerHTML = '<i class="fas fa-satellite-dish"></i>';
        pingMcpServerBtn.disabled = false;
    }
});
