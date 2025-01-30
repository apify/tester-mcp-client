/* eslint-disable no-console */
// client.js

// ===== DOM Elements =====
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

// Keep local messages for display (optional)
const messages = [];

/** 1) Immediately open SSE to /sse */
const eventSource = new EventSource('/sse');

eventSource.onmessage = (event) => {
    let data;
    try {
        data = JSON.parse(event.data);
    } catch {
        console.warn('Could not parse SSE event as JSON:', event.data);
        return;
    }
    // data should be { role, content }
    appendMessage(data.role, data.content);
};

eventSource.onerror = (err) => {
    console.error('SSE error:', err);
    appendMessage('internal', `SSE connection error: ${JSON.stringify(err.message) || err}`);
};

// Then call connectSSE as soon as the browser is ready:
document.addEventListener('DOMContentLoaded', () => {
    reconnect();
});

/**
 * 2) Main function to append messages to the chat.
 *    If content is an array with tool blocks, we separate them out.
 */
function appendMessage(role, content) {
    messages.push({ role, content });

    if (Array.isArray(content)) {
        // We got an array. Possibly tool calls or multiple blocks
        for (const item of content) {
            if (item.type === 'tool_use' || item.type === 'tool_result') {
                appendToolBlock(item);
            } else {
                // If it's not recognized as a tool block, treat it as normal content
                appendSingleBubble(role, item);
            }
        }
    } else {
        // Normal single content (string, object, etc.)
        appendSingleBubble(role, content);
    }
}

/**
 * 3) Append a single bubble row for normal user/assistant/internal text.
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
 * 4) Append a separate row for tool_use/tool_result,
 *    so it doesn't appear in the user or assistant bubble.
 */
function appendToolBlock(item) {
    const row = document.createElement('div');
    row.className = 'message-row tool-row';

    // We'll put everything in a "tool-block" container (no bubble)
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
</details>
`;
    } else if (item.type === 'tool_result') {
        const summary = item.is_error ? 'Tool result (Error)' : 'Tool result';
        container.innerHTML = `
<details>
  <summary>${summary}</summary>
  ${formatAnyContent(item.content)}
</details>
`;
    }

    row.appendChild(container);
    chatLog.appendChild(row);
    chatLog.scrollTop = chatLog.scrollHeight;
}

/**
 * 5) Format content:
 *    - If string: attempt naive JSON parse → fallback markdown
 *    - If object: show as JSON
 */
function formatAnyContent(content) {
    if (typeof content === 'string') {
        // Try JSON parse
        try {
            const obj = JSON.parse(content);
            return `<pre>${escapeHTML(JSON.stringify(obj, null, 2))}</pre>`;
        } catch {
            // Not JSON → fallback to markdown
            return formatMarkdown(content);
        }
    }

    if (content && typeof content === 'object') {
        // If it's an object (not array), show JSON
        return `<pre>${escapeHTML(JSON.stringify(content, null, 2))}</pre>`;
    }

    // fallback for numbers, booleans, etc.
    return String(content);
}

/**
 * Naive markdown transform for code blocks, inline code, bold, italics, links
 */
function formatMarkdown(text) {
    let safe = escapeHTML(text);
    // Fenced code blocks
    safe = safe.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
    // Inline code
    safe = safe.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Bold
    safe = safe.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Italics
    safe = safe.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    // Links [text](url)
    safe = safe.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    // Newlines
    safe = safe.replace(/\n/g, '<br>');
    return safe;
}

/** Escape special HTML chars */
function escapeHTML(str) {
    if (typeof str !== 'string') return String(str);
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * 6) Send user query to /message (POST)
 */
async function sendQuery(query) {
    spinner.style.display = 'inline-block'; // show spinner
    appendMessage('user', query); // local echo

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

/** 7) Attach event listeners */
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

document.addEventListener('DOMContentLoaded', async () => {
    try {
        const resp = await fetch('/client-info');
        const data = await resp.json();

        if (mcpSseUrl) {
            mcpSseUrl.textContent = data.mcpSseUrl;
        }
        // Show the system prompt in a collapsible <details> (assuming you have <pre id="systemPromptPre">)
        if (clientInfo) {
            clientInfo.textContent = `Model name: ${data.modelName}\nSystem prompt: ${data.systemPrompt}`;
        }

        if (information) {
            information.innerHTML = `${data.information}`;
        }
    } catch (err) {
        console.error('Error fetching client info:', err);
    }
});

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

async function reconnect() {
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

reconnectBtn.addEventListener('click', async () => {
    mcpServerStatus.textContent = 'Reconnecting...';
    /* eslint-disable-next-line no-promise-executor-return */
    await new Promise((resolve) => setTimeout(resolve, 500));
    await reconnect();
});

setInterval(async () => {
    await checkConnection();
}, 5000);
