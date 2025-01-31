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
const spinner = document.getElementById('spinner');
const statusIcon = document.getElementById('statusIcon');

const messages = []; // Local message array for display only

// ================== SSE CONNECTION SETUP ==================
const eventSource = new EventSource('/sse');

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
    appendMessage('internal', `SSE connection error: ${JSON.stringify(err.message) || err}`);
};

// ================== ON PAGE LOAD (DOMContentLoaded) ==================
//  - Fetch client info
//  - Set up everything else
document.addEventListener('DOMContentLoaded', async () => {
    // Immediately call /client-info
    try {
        const resp = await fetch('/client-info');
        const data = await resp.json();

        if (mcpSseUrl) {
            mcpSseUrl.textContent = data.mcpSseUrl;
        }
        if (clientInfo) {
            clientInfo.textContent = `Model name: ${data.modelName}\nSystem prompt: ${data.systemPrompt}`;
        }
        if (information) {
            information.innerHTML = `${data.information}`;
        }
    } catch (err) {
        console.error('Error fetching client info:', err);
    }

    // Then attempt reconnect once the page is ready
    reconnect();
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
    chatLog.scrollTop = chatLog.scrollHeight;
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
  <div style="font-size: 0.9rem; margin: 6px 0;">
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
    chatLog.scrollTop = chatLog.scrollHeight;
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
    spinner.style.display = 'inline-block'; // show spinner
    appendMessage('user', query);

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
        spinner.style.display = 'none'; // hide spinner
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

async function checkConnection() {
    fetch('/pingMcpServer')
        .then((resp) => resp.json())
        .then((data) => {
            if (mcpServerStatus) {
                updateMcpServerStatus(data.status);
            }
        })
        .catch((err) => {
            console.error('Network error calling /pingMcpServer:', err);
            if (mcpServerStatus) {
                mcpServerStatus.textContent = 'Network error';
            }
        });
}

function reconnect() {
    fetch('/reconnect', { method: 'POST' })
        .then((resp) => resp.json())
        .then((data) => {
            if (mcpServerStatus) {
                updateMcpServerStatus(data.status);
            }
        })
        .catch((err) => {
            console.error('Network error calling /reconnect:', err);
            if (mcpServerStatus) {
                updateMcpServerStatus('Network error');
            }
        });
}

function updateMcpServerStatus(status) {
    const isOk = status === true || status === 'OK';
    if (isOk) {
        statusIcon.style.backgroundColor = 'green';
        mcpServerStatus.textContent = 'OK';
    } else {
        statusIcon.style.backgroundColor = 'red';
        mcpServerStatus.textContent = 'Disconnected';
    }
}

// Reconnect button logic
reconnectBtn.addEventListener('click', async () => {
    mcpServerStatus.textContent = 'Reconnecting...';
    /* eslint-disable-next-line no-promise-executor-return */
    await new Promise((resolve) => setTimeout(resolve, 2000));
    reconnect();
});

// Periodically check the connection status
setInterval(async () => {
    await checkConnection();
}, 5000);

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
