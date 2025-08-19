/* eslint-disable no-console */
// client.js

// ================== DOM ELEMENTS & GLOBAL STATE ==================
const chatLog = document.getElementById('chatLog');
const clearBtn = document.getElementById('clearBtn');
const clientInfo = document.getElementById('clientInfo');
const information = document.getElementById('information');
const mcpUrl = document.getElementById('mcpUrl');
const queryInput = document.getElementById('queryInput');
const sendBtn = document.getElementById('sendBtn');
const reconnectMcpServerBtn = document.getElementById('reconnectMcpServerButton');
const toolsContainer = document.getElementById('availableTools');
const toolsLoading = document.getElementById('toolsLoading');

// State for tracking message processing
let isProcessingMessage = false;

/**
 * Checks if the user is scrolling.
 * Determines if the user is not at the bottom of the chat log.
 @param {number} tolerance - The tolerance in pixels to consider the user as scrolling (default is 50).
 @returns {boolean} - True if the user is scrolling, false otherwise.
 */
function isUserScrolling(tolerance = 50) {
    // Check if the user is not at the bottom of the page
    return window.scrollY + window.innerHeight < document.body.scrollHeight - tolerance;
}

// Simple scroll to bottom function
function scrollToBottom() {
    // Scroll to bottom of the page
    window.scrollTo(0, document.body.scrollHeight);
}

const messages = []; // Local message array for display only
const actorTimeoutCheckDelay = 60_000; // 60 seconds between checks
let timeoutCheckInterval = null; // Will store the interval ID
let eventSource = null;
let reconnectAttempts = 0;
const maxReconnectAttempts = 3; // Reduced to 3 attempts
const sseReconnectDelay = 3000; // 3 seconds between attempts

// Fix base path handling:
// When running the Actor locally on a worker, the URL includes a path segment, e.g. http://localhost:8002/93kgpcnrtfjv/
// On the Apify platform, the URL is simpler, e.g. https://fqmagpwmiqsj.runs.apify.net/
// This code dynamically adjusts the EventSource URL to work correctly in both environments by using the current window pathname as the base.
let basePath = window.location.pathname;
if (basePath.endsWith('/')) {
    basePath = basePath.slice(0, -1);
}

// ================== SSE CONNECTION SETUP ==================

// Function to handle incoming SSE messages
function handleSSEMessage(event) {
    let data;
    try {
        data = JSON.parse(event.data);
    } catch {
        console.warn('Could not parse SSE event as JSON:', event.data);
        return;
    }
    console.log('Received SSE message:', data);
    // Handle finished flag
    if (data.finished) {
        isProcessingMessage = false;
        sendBtn.innerHTML = '<i class="fas fa-arrow-up"></i>';
        queryInput.focus();
        if (data.error) {
            appendMessage('internal', `Error: ${data.content}`);
        }
        return;
    }
    appendMessage(data.role, data.content, data.key);
}

// Function to handle SSE errors
function handleSSEError(err) {
    console.error('SSE error:', err);
    const errorMessage = err instanceof Error ? err.message : 'Connection lost from Browser to MCP-tester-client server.';
    console.log(errorMessage);

    // Close the current connection if it exists
    if (eventSource) {
        eventSource.close();
        eventSource = null;
    }
    reconnectMcpServerBtn.classList.remove('connected');
    reconnectMcpServerBtn.classList.add('disconnected');
    // Only show the reconnection message if we haven't exceeded max attempts
    if (reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++;
        const attemptNum = reconnectAttempts;
        appendMessage('internal', `${errorMessage} Attempting to reconnect (${attemptNum}/${maxReconnectAttempts})`);
        // Attempt to reconnect after a delay
        setTimeout(() => createSSEConnection(false), sseReconnectDelay);
    } else {
        appendMessage('internal', 'Maximum reconnection attempts reached. Try clicking the "Reconnect MCP Server" button in the toolbar or refresh the page.');
    }
}

/**
 * Unified function to create an SSE connection
 * @param {boolean} isInitial - Whether this is an initial connection (resets reconnect attempts)
 * @param {boolean} force - Whether to force a connection attempt regardless of max attempts
 * @returns {boolean} - Whether a new connection was successfully initiated
 */
function createSSEConnection(isInitial = true, force = false) {
    // Check for max reconnect attempts unless forced
    if (!isInitial && !force && reconnectAttempts >= maxReconnectAttempts) {
        appendMessage('internal', 'Connection failed. Please try clicking the "Reconnect" button in the toolbar or refresh the page.');
        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }
        reconnectMcpServerBtn.classList.remove('connected');
        reconnectMcpServerBtn.classList.add('disconnected');
        // Re-enable the send button on connection failure
        isProcessingMessage = false;
        sendBtn.disabled = false;
        sendBtn.style.cursor = 'pointer';
        queryInput.focus();
        return false;
    }
    // Reset reconnect attempts for initial connections
    if (isInitial) {
        reconnectAttempts = 0;
    }
    // Close any existing connection before creating a new one
    if (eventSource) {
        eventSource.close();
        eventSource = null;
    }
    try {
        // Create new connection
        eventSource = new EventSource(basePath + '/sse');
        eventSource.onmessage = handleSSEMessage;
        eventSource.onerror = handleSSEError;
        eventSource.onopen = () => {
            console.log('SSE connection opened successfully');
            appendMessage('internal', 'Connected to MCP server!');
            reconnectAttempts = 0; // Reset reconnect attempts on successful connection
            reconnectMcpServerBtn.classList.remove('disconnected');
            reconnectMcpServerBtn.classList.add('connected');
            // Re-enable the send button on successful connection
            isProcessingMessage = false;
            sendBtn.disabled = false;
            sendBtn.style.cursor = 'pointer';
            queryInput.focus();
        };
        return true;
    } catch (err) {
        console.error('Error creating SSE connection:', err);
        appendMessage('internal', `Failed to establish connection: ${err.message}`);
        reconnectMcpServerBtn.classList.remove('connected');
        reconnectMcpServerBtn.classList.add('disconnected');
        // Re-enable the send button on connection error
        return false;
    }
}
// Call setup on a page load
createSSEConnection(true);

// ================== ON PAGE LOAD (DOMContentLoaded) ==================
//  - Fetch client info
//  - Set up everything else

// Initial connection on a page load
document.addEventListener('DOMContentLoaded', async () => {
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

    try {
        const response = await fetch('/conversation');
        if (response.ok) {
            const conversation = await response.json();
            conversation.forEach(({ role, content }) => {
                appendMessage(role, content);
            });
            scrollToBottom();
        }
    } catch (err) {
        console.warn('Could not load prior conversation:', err);
    }

    setupModals();
    // Initial fetch of tools
    await fetchAvailableTools();
});

// Settings form handling
document.addEventListener('DOMContentLoaded', async () => {
    const settingsForm = document.getElementById('settingsForm');
    const mcpSseUrlInput = document.getElementById('mcpSseUrlInput');
    const modelNameSelect = document.getElementById('modelNameSelect');
    const modelMaxTokensInput = document.getElementById('modelMaxTokensInput');
    const maxToolCallsInput = document.getElementById('maxToolCallsInput');
    const toolCallTimeoutInput = document.getElementById('toolCallTimeoutInput');
    const systemPromptInput = document.getElementById('systemPromptInput');
    const resetSettingsBtn = document.getElementById('resetSettingsBtn');
    // Function to load model options dynamically
    async function loadModelOptions() {
        try {
            const resp = await fetch('/schema/models');
            const modelOptions = await resp.json();
            modelNameSelect.innerHTML = '';
            modelOptions.forEach((option) => {
                const optionElement = document.createElement('option');
                optionElement.value = option.value;
                optionElement.textContent = option.label;
                modelNameSelect.appendChild(optionElement);
            });
        } catch (err) {
            console.error('Error loading model options:', err);
            showNotification('Failed to load model options. Using defaults.', 'warning');
        }
    }
    await loadModelOptions();
    // Load current settings
    try {
        const resp = await fetch('/settings');
        const settings = await resp.json();
        mcpSseUrlInput.value = settings.mcpUrl;
        modelNameSelect.value = settings.modelName;
        modelMaxTokensInput.value = settings.modelMaxOutputTokens;
        maxToolCallsInput.value = settings.maxNumberOfToolCallsPerQuery;
        toolCallTimeoutInput.value = settings.toolCallTimeoutSec;
        systemPromptInput.value = settings.systemPrompt;
    } catch (err) {
        console.error('Error loading settings:', err);
        showNotification('Failed to load settings. Please check console for details.', 'error');
    }
    // Handle form submission
    settingsForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const newSettings = {
            mcpUrl: mcpSseUrlInput.value,
            modelName: modelNameSelect.value,
            modelMaxOutputTokens: parseInt(modelMaxTokensInput.value, 10),
            maxNumberOfToolCallsPerQuery: parseInt(maxToolCallsInput.value, 10),
            toolCallTimeoutSec: parseInt(toolCallTimeoutInput.value, 10),
            systemPrompt: systemPromptInput.value,
        };
        try {
            const resp = await fetch('/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newSettings),
            });
            const result = await resp.json();
            if (result.success) {
                showNotification('Settings updated successfully for the current session only. Settings will reset when the Actor is restarted.', 'success');
                hideModal('settingsModal');
                const clientInfoResp = await fetch('/client-info');
                const clientInfoData = await clientInfoResp.json();
                if (mcpUrl) mcpUrl.textContent = clientInfoData.mcpUrl;
            } else {
                showNotification(`Failed to update settings: ${result.error}`, 'error');
            }
        } catch (err) {
            console.error('Error saving settings:', err);
            showNotification('Failed to save settings. Please check console for details.', 'error');
        }
    });
    // Reset settings to defaults
    resetSettingsBtn.addEventListener('click', async () => {
        try {
            const resp = await fetch('/settings/reset', { method: 'POST' });
            const result = await resp.json();
            if (result.success) {
                await loadModelOptions();
                // Reload the form with defaults from the server
                const settingsResp = await fetch('/settings');
                const settings = await settingsResp.json();
                mcpSseUrlInput.value = settings.mcpUrl;
                modelNameSelect.value = settings.modelName;
                modelMaxTokensInput.value = settings.modelMaxOutputTokens;
                maxToolCallsInput.value = settings.maxNumberOfToolCallsPerQuery;
                toolCallTimeoutInput.value = settings.toolCallTimeoutSec;
                systemPromptInput.value = settings.systemPrompt;
                showNotification('Settings reset to defaults successfully!', 'success');
            } else {
                showNotification(`Failed to reset settings: ${result.error}`, 'error');
            }
        } catch (err) {
            console.error('Error resetting settings:', err);
            showNotification('Failed to reset settings. Please check console for details.', 'error');
        }
    });
});

// Utility to show notifications
function showNotification(message, type = 'info') {
    const existingNotification = document.querySelector('.notification');
    if (existingNotification) {
        existingNotification.remove();
    }
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.style.marginBottom = '5px'; // Add 5px margin to bottom
    notification.textContent = message;
    chatLog.parentNode.insertBefore(notification, chatLog);

    // Auto-dismiss
    setTimeout(() => {
        if (notification.parentNode) {
            notification.remove();
        }
    }, 7000);
}

// ================== MAIN CHAT LOGIC: APPEND MESSAGES & TOOL BLOCKS ==================

/**
* Fix message order by key
@returns {void}
*/
function fixMessageOrder() {
    // Fix order of messages array
    messages.sort((a, b) => a.key - b.key);

    // Fix message DOM elements
    const messageElements = chatLog.getElementsByClassName('message-row');
    for (let i = 1; i < messageElements.length; i++) {
        const message = messageElements[i];
        const previousMessage = messageElements[i - 1];

        // Skip if either message does not have a key
        if (!message.dataset.key || !previousMessage.dataset.key) {
            continue;
        }

        try {
            const messageKey = parseInt(message.dataset.key, 10);
            const previousMessageKey = parseInt(previousMessage.dataset.key, 10);

            if (messageKey < previousMessageKey) {
                console.log('Reordering message', message, 'placing it before', previousMessage);
                chatLog.insertBefore(message, previousMessage);
            }
        } catch (error) {
            console.error('Error reordering message:', error);
        }
    }
}

/**
 * appendMessage(role, content, key):
 *   If content is an array (potential tool blocks),
 *   handle each item separately; otherwise just show a normal bubble.
 @param {string} role - The role of the message (user, assistant, internal)
 @param {string|array} content - The content of the message (string or array of items)
 @param {number|undefined} [key] - Optional key of the message (used for ordering)
 */
function appendMessage(role, content, key = undefined) {
    // Always scroll to bottom when user sends the message
    // otherwise only when user is not scrolling chat history
    const shouldScrollToBottom = role === 'user' ? true : !isUserScrolling();
    messages.push({ role, content, key });

    if (Array.isArray(content)) {
        content.forEach((item) => {
            if (item.type === 'tool_use' || item.type === 'tool_result') {
                appendToolBlock(item, key);
            } else {
                appendSingleBubble(role, item, key);
            }
        });
    } else {
        // normal single content
        appendSingleBubble(role, content, key);
    }

    // Fix message order after appending
    fixMessageOrder();

    if (shouldScrollToBottom) scrollToBottom();
}

/**
 * appendSingleBubble(role, content, key): Renders a normal user/assistant/internal bubble
 @param {string} role - The role of the message (user, assistant, internal)
 @param {string} content - The content of the message
 @param {number|undefined} [key] - Optional key of the message (used for ordering)
 */
function appendSingleBubble(role, content, key) {
    const row = document.createElement('div');
    row.className = 'message-row';
    if (key !== undefined) row.setAttribute('data-key', key);

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
}

/**
 * isBase64(str): Returns true if the str is base64
 */
function isBase64(str) {
    if (typeof str !== 'string') return false;
    const s = str.trim();
    // base64 must be multiple of 4 chars
    if (!s || s.length % 4 !== 0) return false;
    // only valid base64 chars + optional padding
    return /^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s);
}

/**
 * appendToolBlock(item, key): Renders a separate row for tool_use/tool_result
 @param {object} item - The tool use or result item
 @param {number|undefined} [key] - Optional key of the message (used for ordering)
 */
function appendToolBlock(item, key) {
    const row = document.createElement('div');
    row.className = 'message-row tool-row';
    if (key !== undefined) row.setAttribute('data-key', key);

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
                <div class="tool-call">Tool call: ${item.name || 'N/A'}</div>
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
        let resultContent = '<em>No content</em>';
        let statusText;
        let iconHtml;

        if (item.is_error) {
            statusText = 'Error';
            iconHtml = `<div class="tool-icon" style="background-color: #ff3342;">
                <i class="fas fa-file-alt"></i>
            </div>`;
        } else {
            statusText = 'Success';
            iconHtml = `<div class="tool-icon">
                <i class="fas fa-file-alt"></i>
            </div>`;
        }

        if (Array.isArray(item.content)) {
            resultContent = item.content.map((contentItem) => {
                if (typeof contentItem === 'object' && contentItem.type === 'image') {
                    // Handle both formats: direct data and Anthropic source format
                    let imageData = contentItem.data;
                    let mediaType = 'image/png'; // default fallback

                    if (!imageData && contentItem.source && contentItem.source.data) {
                        imageData = contentItem.source.data;
                        mediaType = contentItem.source.media_type || 'image/png';
                    }

                    if (imageData) {
                        return `<div class="image-result">
                            ${contentItem.text ? `<p>${contentItem.text}</p>` : ''}
                            <img src="data:${mediaType};base64,${imageData}" style="max-width: 100%; height: auto; border-radius: 8px; margin: 10px 0;" alt="Tool result image" />
                        </div>`;
                    }
                    return formatAnyContent(contentItem);
                }
                if (typeof contentItem === 'object' && contentItem.type === 'text') {
                    return `<div class="text-result">${formatMarkdown(contentItem.text || '')}</div>`;
                }
                return formatAnyContent(contentItem);
            }).join('');
        } else {
            resultContent = formatAnyContent(item.content);
        }

        const contentLength = typeof item.content === 'string'
            ? item.content.length
            : JSON.stringify(item.content || '').length;

        container.innerHTML = `
<details class="tool-details">
    <summary>
        <div class="tool-header">
            ${iconHtml}
            <div class="tool-info">
                <div class="tool-call">Tool result: ${statusText}</div>
                <div class="tool-meta">${contentLength} chars</div>
            </div>
            <div class="tool-status">
                <i class="fas fa-chevron-down"></i>
            </div>
        </div>
    </summary>
    <div class="tool-content">
        <div class="tool-result">
            <div class="tool-label">Output:</div>
            <div class="tool-result-content">
                ${resultContent}
            </div>
        </div>
    </div>
</details>`;
    }

    row.appendChild(container);
    chatLog.appendChild(row);

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

/** HTML escaper for <pre> blocks, etc. */
function escapeHTML(str) {
    if (typeof str !== 'string') return String(str);
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function formatAnyContent(content) {
    if (typeof content === 'string') {
        // Check if it's base64 image data
        if (isBase64ImageData(content)) {
            return `<img src="data:image/png;base64,${content}" style="max-width: 100%; height: auto; border-radius: 8px; margin: 10px 0;" alt="Generated image" />`;
        }
        // Try JSON parse for other content
        try {
            const parsed = JSON.parse(content);
            return `<pre><code>${escapeHTML(JSON.stringify(parsed, null, 2))}</code></pre>`;
        } catch {
            // Looks like truncated JSON
            const trimmed = content.trim();
            if ((trimmed.startsWith('{') || trimmed.startsWith('['))
                && (trimmed.includes('"') || trimmed.includes(':'))) {
                return `<pre>${escapeHTML(formatLikeJSON(trimmed))}</pre>`;
            }
            // fallback to markdown
            return formatMarkdown(content);
        }
    }

    if (content && typeof content === 'object') {
        // Check if object contains image data
        if (content.type === 'image' && content.data) {
            const mediaType = content.source?.media_type || 'image/png';
            return `<img src="data:${mediaType};base64,${content.data}" style="max-width: 100%; height: auto; border-radius: 8px; margin: 10px 0;" alt="Generated image" />`;
        }
        // Handle array of content blocks
        if (Array.isArray(content)) {
            return content.map((item) => {
                if (item.type === 'image' && item.data) {
                    const mediaType = item.source?.media_type || 'image/png';
                    return `<img src="data:${mediaType};base64,${item.data}" style="max-width: 100%; height: auto; border-radius: 8px; margin: 10px 0;" alt="Generated image" />`;
                } if (item.type === 'text') {
                    return formatMarkdown(item.text || '');
                }
                return formatAnyContent(item);
            }).join('<br>');
        }
        // Plain object → JSON
        return `<pre><code>${escapeHTML(JSON.stringify(content, null, 2))}</code></pre>`;
    }

    // fallback
    return String(content);
}

// Add helper function to detect base64 image data
function isBase64ImageData(str) {
    if (typeof str !== 'string') return false;
    // Check if it's a reasonable length for image data and is valid base64
    return str.length > 100 && isBase64(str) && !str.includes('"') && !str.includes('{');
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

// Helper function to add basic indentation to JSON-like strings
function formatLikeJSON(str) {
    let indentLevel = 0;
    let result = '';
    let inString = false;
    let escaped = false;

    for (let i = 0; i < str.length; i++) {
        const char = str[i];
        const nextChar = str[i + 1] || '';
        const nextNextChar = str[i + 2] || '';

        if (!inString) {
            if (char === '"' && !escaped) {
                inString = true;
            } else if (char === '{' || char === '[') {
                result += char;
                indentLevel++;
                if (nextChar && nextChar !== '}' && nextChar !== ']') {
                    result += `\n${'  '.repeat(indentLevel)}`;
                }
                continue;
            } else if (char === '}' || char === ']') {
                if (result[result.length - 1] !== '\n') {
                    result += `\n${'  '.repeat(Math.max(0, indentLevel - 1))}`;
                } else {
                    result = `${result.trimEnd()}\n${'  '.repeat(Math.max(0, indentLevel - 1))}`;
                }
                indentLevel = Math.max(0, indentLevel - 1);
                result += char;
                if (nextChar === ',' && nextNextChar) {
                    result += `,\n${'  '.repeat(indentLevel)}`;
                    i++; // skip the comma
                }
                continue;
            } else if (char === ',' && !inString) {
                result += `${char}\n${'  '.repeat(indentLevel)}`;
                continue;
            } else if (char === ':' && !inString) {
                result += `${char} `;
                continue;
            }
        } else if (char === '"' && !escaped) {
            inString = false;
        }

        escaped = (char === '\\' && !escaped);
        result += char;
    }

    return result;
}

// ================== SENDING A USER QUERY (POST /message) ==================
async function sendQuery(query) {
    if (isProcessingMessage) return;
    // Set processing state
    isProcessingMessage = true;
    // Show spinner in send button but keep it enabled
    sendBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    // First append the user message
    appendMessage('user', query);

    try {
        const resp = await fetch('/message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query }),
        });
        const data = await resp.json();
        if (data.error) {
            console.log('Server error:', data.error);
            appendMessage('internal', `Server error: ${data.error}`);
        }
    } catch (err) {
        console.log('Network error:', err);
        appendMessage('internal', 'Network error. Try to reconnect or reload page');
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
    if (query && !isProcessingMessage) {
        sendQuery(query);
        queryInput.value = '';
        queryInput.style.height = 'auto';
    }
});

queryInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!isProcessingMessage) {
            sendBtn.click();
        }
    }
});

// Add ping function to check MCP server connection status
async function reconnectAndPing() {
    try {
        // Force a new connection attempt
        createSSEConnection(false, true);
        const resp = await fetch('/reconnect-mcp-server');
        const data = await resp.json();
        console.log('Ping response:', data);
        if (data.status !== true && data.status !== 'OK') {
            appendMessage('internal', 'Not connected');
        }
    } catch (err) {
        appendMessage('internal', `Error reconnecting to MCP server: ${err.message}`);
    }
}

// Add click handler for reconnect button
reconnectMcpServerBtn.addEventListener('click', async () => {
    try {
        // Add visual feedback
        reconnectMcpServerBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        reconnectMcpServerBtn.disabled = true;
        await reconnectAndPing();
    } finally {
        // Reset button state
        reconnectMcpServerBtn.innerHTML = '<i class="fas fa-satellite-dish"></i>';
        reconnectMcpServerBtn.disabled = false;
    }
});

// ================== AVAILABLE TOOLS ==================
// Fetch available tools
async function fetchAvailableTools() {
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

    tools.forEach((tool) => {
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

// ================== MODAL HANDLING ==================

// Function to show a modal
function showModal(modalId) {
    const modalElement = document.getElementById(modalId);
    if (modalElement) {
        modalElement.style.display = 'block';
        document.body.style.overflow = 'hidden'; // Prevent scrolling
        // Refresh tools when tools modal is opened
        if (modalId === 'toolsModal') {
            fetchAvailableTools();
        }
    }
}

// Function to hide a modal
function hideModal(modalId) {
    const modalElement = document.getElementById(modalId);
    if (modalElement) {
        modalElement.style.display = 'none';
        document.body.style.overflow = ''; // Restore scrolling
    }
}

function setupModals() {
    // Get button elements
    const quickStartBtn = document.getElementById('quickStartBtn');
    const settingsBtn = document.getElementById('settingsBtn');
    const toolsBtn = document.getElementById('toolsBtn');

    // Set up example question clicks - only for the first list
    const exampleQuestions = document.querySelectorAll('#quickStartModal .modal-body h4:first-of-type + ul li');
    exampleQuestions.forEach((question) => {
        question.addEventListener('click', () => {
            const text = question.textContent.trim();
            hideModal('quickStartModal');
            queryInput.value = text;
            queryInput.focus();
            queryInput.style.height = 'auto';
            queryInput.style.height = `${Math.min(queryInput.scrollHeight, 150)}px`;
        });
    });

    // Add click handlers for modal buttons
    quickStartBtn.addEventListener('click', () => showModal('quickStartModal'));
    settingsBtn.addEventListener('click', () => showModal('settingsModal'));
    toolsBtn.addEventListener('click', () => showModal('toolsModal'));

    // Add click handlers for close buttons
    document.querySelectorAll('.close-modal').forEach((button) => {
        button.addEventListener('click', () => {
            const modal = button.closest('.modal');
            if (modal) {
                hideModal(modal.id);
            }
        });
    });

    let mouseDownOnModal = false;
    window.addEventListener('mousedown', (event) => {
        mouseDownOnModal = event.target.classList.contains('modal');
    });
    window.addEventListener('mouseup', (event) => {
        if (mouseDownOnModal && event.target.classList.contains('modal')) {
            hideModal(event.target.id);
        }
        mouseDownOnModal = false;
    });

    // Close modal with Escape key
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            document.querySelectorAll('.modal').forEach((modal) => {
                if (modal.style.display === 'block') {
                    hideModal(modal.id);
                }
            });
        }
    });
}
