import { useCallback, useEffect, useMemo, useState } from 'react';
import { getToolName, isToolUIPart, TextStreamChatTransport, type ToolUIPart } from 'ai';
import { useChat } from '@ai-sdk/react';
import { CopyIcon, RefreshCcwIcon, SettingsIcon, WrenchIcon } from 'lucide-react';

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import {
  Message,
  MessageActions,
  MessageAction,
  MessageContent,
  MessageResponse,
} from '@/components/ai-elements/message';
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  type PromptInputMessage,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input';
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';
import { Loader } from '@/components/ai-elements/loader';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

const models = [
  { name: 'Claude Haiku 4.5', value: 'anthropic/claude-haiku-4.5' },
  { name: 'Claude Sonnet 4.5', value: 'anthropic/claude-sonnet-4.5' },
  { name: 'Gemini 3 Flash (Preview)', value: 'google/gemini-3-flash-preview' },
  { name: 'GPT-5.2 Chat', value: 'openai/gpt-5.2-chat' },
];

type ToolSummary = {
  name: string;
  title?: string;
};

type Settings = {
  mcpUrl: string;
  mcpTransportType: string;
  systemPrompt: string;
  modelName: string;
  modelMaxOutputTokens: number;
  maxNumberOfToolCallsPerQuery: number;
  toolCallTimeoutSec: number;
};

const TOOL_PREFERENCES_KEY = 'actors-mcp-client-tool-preferences';

const App = () => {
  const transport = useMemo(() => new TextStreamChatTransport({ api: '/api/chat' }), []);
  const { messages, sendMessage, status, regenerate, setMessages } = useChat({ transport });
  const [input, setInput] = useState('');
  const [model, setModel] = useState<string>(models[0].value);
  const [tools, setTools] = useState<Record<string, ToolSummary>>({});
  const [enabledTools, setEnabledTools] = useState<Record<string, boolean>>({});
  const [, setSettings] = useState<Settings | null>(null);
  const [draftSettings, setDraftSettings] = useState<Settings | null>(null);
  const [settingsMessage, setSettingsMessage] = useState('');
  const [toolsError, setToolsError] = useState('');
  const [toolsDialogOpen, setToolsDialogOpen] = useState(false);
  const isSubmitting = status === 'submitted';

  const loadTools = useCallback(async () => {
    try {
      setToolsError('');
      let response = await fetch('/api/tools');
      if (!response.ok) {
        response = await fetch('/available-tools');
      }
      if (!response.ok) {
        setToolsError('Failed to load tools. Check MCP settings.');
        return;
      }
      const data = (await response.json()) as { tools?: ToolSummary[] };
      const toolList = Array.isArray(data.tools) ? data.tools : [];
      const toolMap = Object.fromEntries(toolList.map((tool) => [tool.name, tool]));
      setTools(toolMap);

      const defaults = Object.fromEntries(toolList.map((tool) => [tool.name, true]));
      const storedRaw = window.localStorage.getItem(TOOL_PREFERENCES_KEY);
      let stored = {};
      if (storedRaw) {
        try {
          stored = JSON.parse(storedRaw) as Record<string, boolean>;
        } catch {
          stored = {};
        }
      }
      const merged = { ...defaults, ...stored };
      const filtered = Object.fromEntries(
        Object.entries(merged).filter(([name]) => name in toolMap),
      );
      setEnabledTools(filtered);
    } catch {
      setToolsError('Failed to load tools. Check MCP settings.');
    }
  }, []);
  useEffect(() => {
    void loadTools();
  }, [loadTools]);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const response = await fetch('/settings');
        const data = await response.json();
        const next = {
          mcpUrl: data.mcpUrl ?? '',
          mcpTransportType: data.mcpTransportType ?? 'http',
          systemPrompt: data.systemPrompt ?? '',
          modelName: data.modelName ?? 'anthropic/claude-haiku-4.5',
          modelMaxOutputTokens: Number(data.modelMaxOutputTokens ?? 2048),
          maxNumberOfToolCallsPerQuery: Number(data.maxNumberOfToolCallsPerQuery ?? 5),
          toolCallTimeoutSec: Number(data.toolCallTimeoutSec ?? 300),
        } as Settings;
        setSettings(next);
        setDraftSettings(next);
        setModel(next.modelName);
      } catch {
        setSettingsMessage('Failed to load settings.');
      }
    };

    void loadSettings();
  }, []);

  useEffect(() => {
    if (Object.keys(enabledTools).length === 0) {
      return;
    }
    window.localStorage.setItem(TOOL_PREFERENCES_KEY, JSON.stringify(enabledTools));
  }, [enabledTools]);

  const enabledToolNames = useMemo(
    () => Object.entries(enabledTools).filter(([, enabled]) => enabled).map(([name]) => name),
    [enabledTools],
  );

  const enabledCount = enabledToolNames.length;
  const toolMetaByName = useMemo(() => tools, [tools]);

  const openToolsDialog = useCallback(() => {
    setToolsDialogOpen(true);
    void loadTools();
  }, [loadTools]);
  const handleSubmit = (message: PromptInputMessage) => {
    const hasText = Boolean(message.text);
    const hasAttachments = Boolean(message.files?.length);
    if (!(hasText || hasAttachments)) {
      return;
    }
    const enabledToolKeys = Object.keys(enabledTools);
    sendMessage(
      {
        text: message.text || 'Sent with attachments',
        files: message.files,
      },
      {
        body: {
          model,
          ...(enabledToolKeys.length > 0 ? { enabledTools: enabledToolNames } : {}),
        },
      },
    );
    setInput('');
  };

  const resetConversation = async () => {
    try {
      await fetch('/conversation/reset', { method: 'POST' });
    } catch {
      setSettingsMessage('Failed to reset conversation.');
    } finally {
      setMessages([]);
    }
  };

  const saveSettings = async () => {
    if (!draftSettings) return;
    setSettingsMessage('Saving...');
    try {
      const response = await fetch('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draftSettings),
      });
      const result = await response.json();
      if (result.success) {
        setSettings(draftSettings);
        setModel(draftSettings.modelName);
        setSettingsMessage('Settings saved.');
      } else {
        setSettingsMessage(result.error || 'Failed to save settings.');
      }
    } catch {
      setSettingsMessage('Failed to save settings.');
    }
  };

  const resetSettings = async () => {
    setSettingsMessage('Resetting...');
    try {
      const response = await fetch('/settings/reset', { method: 'POST' });
      const result = await response.json();
      if (result.success) {
        const refreshed = await fetch('/settings');
        const data = await refreshed.json();
        const next = {
          mcpUrl: data.mcpUrl ?? '',
          mcpTransportType: data.mcpTransportType ?? 'http',
          systemPrompt: data.systemPrompt ?? '',
          modelName: data.modelName ?? 'anthropic/claude-haiku-4.5',
          modelMaxOutputTokens: Number(data.modelMaxOutputTokens ?? 2048),
          maxNumberOfToolCallsPerQuery: Number(data.maxNumberOfToolCallsPerQuery ?? 5),
          toolCallTimeoutSec: Number(data.toolCallTimeoutSec ?? 300),
        } as Settings;
        setSettings(next);
        setDraftSettings(next);
        setModel(next.modelName);
        setSettingsMessage('Defaults restored.');
      } else {
        setSettingsMessage(result.error || 'Failed to reset settings.');
      }
    } catch {
      setSettingsMessage('Failed to reset settings.');
    }
  };

  const handleDraftChange = (field: keyof Settings, value: string | number) => {
    setDraftSettings((prev) => (prev ? { ...prev, [field]: value } : prev));
  };

  return (
    <div className="mx-auto flex h-screen max-w-4xl flex-col p-6">
      <header className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <img className="size-8" src="https://apify.com/favicon.ico" alt="Apify" />
          <div>
            <h1 className="text-base font-semibold">Apify MCP Client</h1>
            <p className="text-muted-foreground text-xs">Tool-aware chat via MCP</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={resetConversation}>
            Reset
          </Button>
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm">
                <SettingsIcon className="mr-2 size-4" />
                Settings
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[80vh] max-w-md overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Runtime configuration</DialogTitle>
                <DialogDescription>Adjust settings for this session.</DialogDescription>
              </DialogHeader>
              <div className="grid gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">MCP server URL</label>
                  <Input
                    value={draftSettings?.mcpUrl ?? ''}
                    onChange={(event) => handleDraftChange('mcpUrl', event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">MCP transport</label>
                  <Input
                    value={draftSettings?.mcpTransportType ?? 'http'}
                    onChange={(event) => handleDraftChange('mcpTransportType', event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Model name</label>
                  <Input
                    value={draftSettings?.modelName ?? ''}
                    onChange={(event) => handleDraftChange('modelName', event.target.value)}
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Max output tokens</label>
                    <Input
                      type="number"
                      value={draftSettings?.modelMaxOutputTokens ?? 0}
                      onChange={(event) => handleDraftChange('modelMaxOutputTokens', Number(event.target.value))}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Max tool calls</label>
                    <Input
                      type="number"
                      value={draftSettings?.maxNumberOfToolCallsPerQuery ?? 0}
                      onChange={(event) => handleDraftChange('maxNumberOfToolCallsPerQuery', Number(event.target.value))}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Tool timeout (sec)</label>
                  <Input
                    type="number"
                    value={draftSettings?.toolCallTimeoutSec ?? 0}
                    onChange={(event) => handleDraftChange('toolCallTimeoutSec', Number(event.target.value))}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">System prompt</label>
                  <Textarea
                    rows={5}
                    value={draftSettings?.systemPrompt ?? ''}
                    onChange={(event) => handleDraftChange('systemPrompt', event.target.value)}
                  />
                </div>
              </div>
              <DialogFooter className="items-center justify-between">
                <span className="text-muted-foreground text-xs">{settingsMessage}</span>
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={resetSettings}>
                    Reset defaults
                  </Button>
                  <Button onClick={saveSettings}>Save</Button>
                </div>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </header>

      <Conversation className="flex-1">
        <ConversationContent>
          {messages.length === 0 && (
            <div className="flex h-full items-center justify-center">
              <div className="text-center text-sm text-muted-foreground">
                <p>Describe the task you want to automate and we will orchestrate the right MCP tools.</p>
                <p>Use the chat to invoke Actors, inspect results, and iterate quickly.</p>
              </div>
            </div>
          )}
          {messages.map((message) => (
            <div key={message.id}>
              {message.parts.map((part, index) => {
                if (isToolUIPart(part)) {
                  const toolName = getToolName(part as ToolUIPart);
                  const meta = toolMetaByName[toolName];
                  const toolTitle = meta?.title ?? part.title ?? toolName;
                  const hasInput = part.input !== undefined;
                  const output = 'output' in part ? part.output : undefined;
                  const errorText = 'errorText' in part ? part.errorText : undefined;

                  return (
                    <Tool key={`${message.id}-${index}`} defaultOpen={part.state !== 'input-streaming'}>
                      <ToolHeader
                        title={toolTitle}
                        type={part.type as ToolUIPart['type']}
                        state={part.state}
                      />
                      <ToolContent>
                        {hasInput && <ToolInput input={part.input} />}
                        <ToolOutput output={output} errorText={errorText} />
                      </ToolContent>
                    </Tool>
                  );
                }

                if (part.type === 'text') {
                  return (
                    <Message key={`${message.id}-${index}`} from={message.role}>
                      <MessageContent>
                        <MessageResponse>{part.text}</MessageResponse>
                      </MessageContent>
                      {message.role === 'assistant' && index === message.parts.length - 1 && (
                        <MessageActions>
                          <MessageAction onClick={() => regenerate()} label="Retry">
                            <RefreshCcwIcon className="size-3" />
                          </MessageAction>
                          <MessageAction
                            onClick={() => navigator.clipboard.writeText(part.text)}
                            label="Copy"
                          >
                            <CopyIcon className="size-3" />
                          </MessageAction>
                        </MessageActions>
                      )}
                    </Message>
                  );
                }

                return null;
              })}
            </div>
          ))}
          <div className="flex h-6 items-center justify-center">
            <Loader aria-hidden={!isSubmitting} className={isSubmitting ? '' : 'invisible'} />
          </div>
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <PromptInput onSubmit={handleSubmit} className="mt-4" globalDrop multiple>
        <PromptInputHeader>
          <PromptInputAttachments>
            {(attachment) => <PromptInputAttachment data={attachment} />}
          </PromptInputAttachments>
        </PromptInputHeader>
        <PromptInputBody>
          <PromptInputTextarea onChange={(event) => setInput(event.target.value)} value={input} />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            <PromptInputActionMenu>
              <PromptInputActionMenuTrigger />
              <PromptInputActionMenuContent>
                <PromptInputActionAddAttachments />
              </PromptInputActionMenuContent>
            </PromptInputActionMenu>
            <PromptInputButton variant="ghost" onClick={openToolsDialog}>
              <WrenchIcon size={16} />
              <span>Tools{Object.keys(tools).length > 0 ? ` (${enabledCount})` : ''}</span>
            </PromptInputButton>
            <PromptInputSelect
              onValueChange={(value) => {
                setModel(value);
                setDraftSettings((prev) => (prev ? { ...prev, modelName: value } : prev));
              }}
              value={model}
            >
              <PromptInputSelectTrigger>
                <PromptInputSelectValue />
              </PromptInputSelectTrigger>
              <PromptInputSelectContent>
                {models.map((entry) => (
                  <PromptInputSelectItem key={entry.value} value={entry.value}>
                    {entry.name}
                  </PromptInputSelectItem>
                ))}
              </PromptInputSelectContent>
            </PromptInputSelect>
          </PromptInputTools>
          <PromptInputSubmit disabled={!input && !status} status={status} />
        </PromptInputFooter>
      </PromptInput>

      <Dialog open={toolsDialogOpen} onOpenChange={setToolsDialogOpen}>
        <DialogContent className="max-w-sm p-4">
          <DialogHeader className="gap-1">
            <DialogTitle className="text-sm">Tools</DialogTitle>
            <DialogDescription className="text-xs">
              Enable or disable tools for the next prompt.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-3 grid gap-2 text-sm">
            {toolsError && (
              <p className="text-destructive text-xs">{toolsError}</p>
            )}
            {!toolsError && Object.keys(tools).length === 0 && (
              <p className="text-muted-foreground text-xs">No tools available.</p>
            )}
            {Object.values(tools).map((tool) => (
              <label key={tool.name} className="flex items-center gap-2 text-sm">
                <input
                  className="border-input text-primary focus-visible:ring-ring h-4 w-4 rounded-sm border focus-visible:ring-2 focus-visible:ring-offset-2"
                  type="checkbox"
                  checked={enabledTools[tool.name] ?? false}
                  onChange={(event) => {
                    setEnabledTools((prev) => ({
                      ...prev,
                      [tool.name]: event.target.checked,
                    }));
                  }}
                />
                <span>{tool.title ?? tool.name}</span>
              </label>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default App;
