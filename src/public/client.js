/* eslint-disable no-console */
// client.js

// ================== DOM ELEMENTS & GLOBAL STATE ==================
const chatLog = document.getElementById('chatLog');
const clearBtn = document.getElementById('clearBtn');
const clientInfo = document.getElementById('clientInfo');
const information = document.getElementById('information');
const mcpServerStatus = document.getElementById('mcpServerStatus');
const mcpSseUrl = document.getElementById('mcpSseUrl');
const queryInput = document.getElementById('queryInput');
const reconnectBtn = document.getElementById('reconnectBtn');
const sendBtn = document.getElementById('sendBtn');
const statusIcon = document.getElementById('statusIcon');
const refreshToolsBtn = document.getElementById('refreshToolsBtn');
const toolsContainer = document.getElementById('availableTools');
const toolsLoading = document.getElementById('toolsLoading');

// Simple scroll to bottom function
function scrollToBottom() {
    // Scroll the chat log
    chatLog.scrollTop = chatLog.scrollHeight;

    // Also scroll the window to ensure we're at the bottom
    window.scrollTo(0, document.body.scrollHeight);
}

const messages = []; // Local message array for display only
const actorTimeoutCheckDelay = 60000; // 60 seconds between checks
let timeoutCheckInterval = null; // Will store the interval ID

let connectionAttempts = 0;
const maxAttempts = 12; // Try for up to 2 minutes (12 * 10 seconds)
const retryDelay = 10000; // 10 seconds between attempts
const regularCheckDelay = 30000; // 30 seconds between checks
const sseReconnectDelay = 2000; // 2 seconds before reconnecting

// Add status message constants
const STATUS = {
    CONNECTED: 'Connected',
    CONNECTING: 'Connecting',
    FAILED: 'Connection failed',
    FAILED_TIMEOUT: 'Failed to connect after multiple attempts',
};

// ================== SSE CONNECTION SETUP ==================
let eventSource = new EventSource('/sse');

// Handle incoming SSE messages
eventSource.onmessage = (event) => {
    let data;
    try {
        data = JSON.parse(event.data);
    } catch {
        console.warn('Could not parse SSE event as JSON:', event.data);
        return;
    }
    // data = { role, content }
    appendMessage(data.role, data.content);
};

// Handle SSE errors
eventSource.onerror = (err) => {
    console.error('SSE error:', err);
    const errorMessage = err instanceof Error ? err.message : 'Connection lost. Attempting to reconnect...';
    appendMessage('internal', errorMessage);

    // Close the current connection
    eventSource.close();

    // Attempt to reconnect after a delay
    setTimeout(reconnectSSE, sseReconnectDelay); // Wait 2 seconds before reconnecting
};

// Reconnection logic extracted into a separate function
function reconnectSSE() {
    console.log('Attempting to reconnect SSE...');
    const newEventSource = new EventSource('/sse');

    newEventSource.onopen = () => {
        console.log('SSE reconnected successfully');
        appendMessage('internal', 'Connection restored!');
        eventSource = newEventSource; // Update the global eventSource reference

        // Reattach message handler
        newEventSource.onmessage = eventSource.onmessage;
        newEventSource.onerror = eventSource.onerror;
    };

    newEventSource.onerror = eventSource.onerror; // Reuse the same error handler
}

// ================== ON PAGE LOAD (DOMContentLoaded) ==================
//  - Fetch client info
//  - Set up everything else

// Initial connection on page load
document.addEventListener('DOMContentLoaded', async () => {
    // Fetch client info first
    try {
        const resp = await fetch('/client-info');
        const data = await resp.json();
        if (mcpSseUrl) mcpSseUrl.textContent = data.mcpSseUrl;
        if (clientInfo) clientInfo.textContent = `Model name: ${data.modelName}\nSystem prompt: ${data.systemPrompt}`;
        if (information) information.innerHTML = `${data.information}`;
    } catch (err) {
        console.error('Error fetching client info:', err);
    }

    // Start connection attempt loop
    await attemptConnection(true);

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

    // Auto-resize textarea
    document.getElementById('queryInput').addEventListener('input', function() {
        // Reset height to auto first to get the correct scrollHeight
        this.style.height = 'auto';
        // Set new height based on content
        const newHeight = Math.min(this.scrollHeight, 150); // Cap at max-height
        this.style.height = newHeight + 'px';
    });

    // Initial connection status check will trigger the tools fetch
    const checkToolsInterval = setInterval(() => {
        const status = mcpServerStatus.textContent;
        if (status === 'Connected') {
            fetchAvailableTools();
            clearInterval(checkToolsInterval);
        }
    }, 1000);

    // Add tools refresh when reconnecting
    reconnectBtn.addEventListener('click', () => {
        showToolsLoading();
        toolsContainer.innerHTML = '';
        document.getElementById('toolsCount').textContent = '';
    });

    // Manual refresh button
    refreshToolsBtn.addEventListener('click', () => {
        showToolsLoading();
        toolsContainer.innerHTML = '';
        document.getElementById('toolsCount').textContent = '';
        fetchAvailableTools();
    });
});

// ================== 4) MAIN CHAT LOGIC: APPEND MESSAGES & TOOL BLOCKS ==================

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
        container.innerHTML = `
<details>
  <summary>Tool use: <strong>${item.name}</strong></summary>
  <div style="font-size: 0.875rem; margin: 0.5rem 0;">
    <strong>ID:</strong> ${item.id || 'unknown'}
  </div>
  ${formatAnyContent(item.input)}
</details>`;
    } else if (item.type === 'tool_result') {
        const summary = item.is_error ? 'Tool result (Error)' : 'Tool result';
        container.innerHTML = `
<details>
  <summary>${summary}</summary>
  ${formatAnyContent(item.content)}
</details>`;
    }

    row.appendChild(container);
    chatLog.appendChild(row);
    scrollToBottom();
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
        <div class="bubble loading">
            <div class="typing-indicator">
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
            </div>
        </div>
    `;

    // Then insert loading indicator as the last child of chatLog
    chatLog.appendChild(loadingRow);
    // Force scroll after adding both message and loading indicator
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
        messages.length = 0;
        chatLog.innerHTML = '';

        const resp = await fetch('/conversation/reset', { method: 'POST' });
        const data = await resp.json();
        if (data.error) {
            console.error('Server error when resetting conversation:', data.error);
        } else {
            console.log('Server conversation reset');
        }
    } catch (err) {
        console.error('Error resetting conversation:', err);
    }
});

// ================== SERVER CONNECTIVITY CHECKS & RECONNECT LOGIC ==================

async function attemptConnection(isInitial = false) {
    if (isInitial) {
        if (connectionAttempts >= maxAttempts) {
            updateMcpServerStatus(STATUS.FAILED);
            appendMessage('internal', `${STATUS.FAILED_TIMEOUT}. Please try reconnecting manually.`);
            return;
        }
        connectionAttempts++;
        updateMcpServerStatus(STATUS.CONNECTING);
        // Add attempt counter inline with smaller font
        const attemptText = document.createElement('small');
        attemptText.style.cssText = `
            margin-left: 0.25rem;
            opacity: 0.7;
            font-size: 0.8em;
            white-space: nowrap;
            display: inline-block;
        `;
        attemptText.textContent = `(${connectionAttempts}/${maxAttempts})`;
        mcpServerStatus.firstElementChild.appendChild(attemptText);
    }

    try {
        const resp = await fetch('/pingMcpServer');
        const data = await resp.json();

        if (data.status === true || data.status === 'OK') {
            updateMcpServerStatus(STATUS.CONNECTED);
            if (isInitial) {
                appendMessage('internal', 'Successfully connected to MCP server!');
                startRegularChecks();
            }
        } else {
            updateMcpServerStatus(STATUS.CONNECTING);
            await fetch('/reconnect', { method: 'POST' });
            if (isInitial) {
                setTimeout(() => attemptConnection(true), retryDelay);
            }
        }
    } catch (err) {
        console.error('Connection attempt failed:', err);
        updateMcpServerStatus(STATUS.FAILED);
        if (isInitial) {
            setTimeout(() => attemptConnection(true), retryDelay);
        }
    }
}

function updateMcpServerStatus(status) {
    const isOk = status === true || status === 'OK' || status === STATUS.CONNECTED;
    if (isOk) {
        statusIcon.style.backgroundColor = '#22c55e'; // green-500
        mcpServerStatus.innerHTML = STATUS.CONNECTED;
    } else if (status === STATUS.CONNECTING) {
        statusIcon.style.backgroundColor = '#f97316'; // orange-500
        mcpServerStatus.innerHTML = `
            <div style="display: flex; align-items: center; white-space: nowrap;">
                ${STATUS.CONNECTING}
                <div class="typing-indicator" style="margin-left: 0.25rem;">
                    <div class="typing-dot"></div>
                    <div class="typing-dot"></div>
                    <div class="typing-dot"></div>
                </div>
            </div>
        `;
    } else {
        statusIcon.style.backgroundColor = '#ef4444'; // red-500
        mcpServerStatus.innerHTML = status;
    }
}

function startRegularChecks() {
    setInterval(() => attemptConnection(false), regularCheckDelay);
}

// Manual reconnect button
reconnectBtn.addEventListener('click', async () => {
    connectionAttempts = 0;
    await attemptConnection(true);
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

// ================== AVAILABLE TOOLS ==================

// Update the toolsLoading element to show the animated typing indicator
function showToolsLoading() {
    toolsLoading.innerHTML = `
        <div style="display: flex; align-items: center;">
            Loading available tools
            <div class="typing-indicator" style="margin-left: 0.25rem;">
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
            </div>
        </div>
    `;
    toolsLoading.style.display = 'block';
}

// Fetch and display available tools

// Fetch available tools
async function fetchAvailableTools() {
    showToolsLoading();
    
    try {
        const response = await fetch('/available-tools');
        const data = await response.json();
        
        if (data.tools && data.tools.length > 0) {
            toolsLoading.style.display = 'none';
            renderTools(data.tools);
        } else {
            toolsLoading.textContent = 'No tools available.';
        }
    } catch (err) {
        toolsLoading.textContent = 'Failed to load tools. Try reconnecting.';
        console.error('Error fetching tools:', err);
    }
}

// Render the tools list
function renderTools(tools) {
    toolsContainer.innerHTML = '';
    
    // Change the tools count
    const toolsCountElement = document.getElementById('toolsCount');
    toolsCountElement.textContent = `(${tools.length})`;
    
    // Expandable list of tools
    const toolsList = document.createElement('ul');
    toolsList.style.paddingLeft = '1.5rem';
    toolsList.style.marginTop = '0.5rem';
    
    tools.forEach(tool => {
        const li = document.createElement('li');
        li.style.marginBottom = '0.75rem';
        
        const toolName = document.createElement('strong');
        toolName.textContent = tool.name;
        li.appendChild(toolName);
        
        if (tool.description) {
            const description = document.createElement('div');
            description.style.fontSize = '0.85rem';
            description.style.marginTop = '0.25rem';
            description.textContent = tool.description;
            li.appendChild(description);
        }
        
        toolsList.appendChild(li);
    });
    
    toolsContainer.appendChild(toolsList);
}
