import { useState, useEffect, useRef } from 'react';
import type { AgentConfig, AgentProvider } from '../../shared/types';
import { useTaskStore } from '../store/taskStore';

interface Props {
  currentPath: string;
  onClose: () => void;
}

const agentProviderOptions: Array<{ value: AgentProvider; label: string }> = [
  { value: 'codex', label: 'Codex' },
  { value: 'claude', label: 'Claude' },
  { value: 'custom', label: 'Custom Command' },
];

export default function SettingsPanel({ currentPath, onClose }: Props) {
  const store = useTaskStore();
  const [shortcut, setShortcut] = useState('Cmd+Shift+T');
  const [agentConfig, setLocalAgentConfig] = useState<AgentConfig>(store.agentConfig);
  const lastSyncedAgentConfigRef = useRef(store.agentConfig);
  const [saved, setSaved] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [isSavingAgent, setIsSavingAgent] = useState(false);
  const [notificationSound, setNotificationSound] = useState('Glass.aiff');
  const [systemSounds, setSystemSounds] = useState<string[]>([]);

  useEffect(() => {
    window.electronAPI.getShortcut().then(setShortcut);
    window.electronAPI.getSystemSounds().then(setSystemSounds);
    window.electronAPI.getNotificationSound().then(setNotificationSound);
    void store.loadAgentConfig();
  }, []);

  const handleNotificationSoundChange = async (sound: string) => {
    setNotificationSound(sound);
    await window.electronAPI.setNotificationSound(sound);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const handlePreviewSound = () => {
    void window.electronAPI.notifyComplete();
  };

  useEffect(() => {
    const previous = lastSyncedAgentConfigRef.current;
    const next = store.agentConfig;
    setLocalAgentConfig((current) => {
      const hasLocalAgentDraft =
        current.provider !== previous.provider ||
        current.customCommand !== previous.customCommand;

      return {
        provider: hasLocalAgentDraft ? current.provider : next.provider,
        customCommand: hasLocalAgentDraft ? current.customCommand : next.customCommand,
        showTerminalControls: next.showTerminalControls,
        skipPermissions: next.skipPermissions,
      };
    });
    lastSyncedAgentConfigRef.current = next;
  }, [store.agentConfig]);

  const handleChangeFile = async () => {
    const newPath = await window.electronAPI.selectTaskFile();
    if (newPath) {
      await window.electronAPI.setDefaultFilePath(newPath);
      store.setFilePath(newPath);
      const result = await window.electronAPI.readTaskFile(newPath);
      store.setTasks(result.tasks);
      await store.loadProjectBinding();
      void store.ensureAgentSession();
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    }
  };

  const handleShortcutChange = async () => {
    await window.electronAPI.setShortcut(shortcut);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const handleAgentProviderChange = (provider: AgentProvider) => {
    setAgentError(null);
    setLocalAgentConfig((current) => ({
      ...current,
      provider,
    }));
  };

  const handleAgentCommandChange = (customCommand: string) => {
    setAgentError(null);
    setLocalAgentConfig((current) => ({
      ...current,
      customCommand,
    }));
  };

  const handleTerminalControlsChange = async (showTerminalControls: boolean) => {
    setAgentError(null);
    const nextLocalConfig: AgentConfig = {
      ...agentConfig,
      showTerminalControls,
    };
    const nextStoredConfig: AgentConfig = {
      ...store.agentConfig,
      showTerminalControls,
    };

    setLocalAgentConfig(nextLocalConfig);
    setIsSavingAgent(true);
    try {
      await store.setAgentConfig(nextStoredConfig);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : 'Failed to save terminal settings.');
    } finally {
      setIsSavingAgent(false);
    }
  };

  const handleSkipPermissionsChange = async (skipPermissions: boolean) => {
    setAgentError(null);
    const nextLocalConfig: AgentConfig = {
      ...agentConfig,
      skipPermissions,
    };
    const nextStoredConfig: AgentConfig = {
      ...store.agentConfig,
      skipPermissions,
    };

    setLocalAgentConfig(nextLocalConfig);
    setIsSavingAgent(true);
    try {
      await store.setAgentConfig(nextStoredConfig);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : 'Failed to save agent settings.');
    } finally {
      setIsSavingAgent(false);
    }
  };

  const handleAgentConfigSave = async () => {
    const nextConfig: AgentConfig = {
      provider: agentConfig.provider,
      customCommand: agentConfig.customCommand.trim(),
      showTerminalControls: agentConfig.showTerminalControls,
      skipPermissions: agentConfig.skipPermissions,
    };

    if (nextConfig.provider === 'custom' && !nextConfig.customCommand) {
      setAgentError('Custom command required.');
      return;
    }

    setIsSavingAgent(true);
    try {
      await store.setAgentConfig(nextConfig);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : 'Failed to save agent.');
    } finally {
      setIsSavingAgent(false);
    }
  };

  return (
    <div className="tick-glass flex h-full w-full flex-col overflow-hidden">
      <div className="drag-region relative grid h-10 shrink-0 grid-cols-[78px_1fr_36px] items-center border-b border-[#E7E9EE] bg-white/95 px-2">
        <div aria-hidden="true" />
        <span className="pointer-events-none absolute inset-x-[78px] top-0 flex h-10 items-center justify-center truncate text-sm font-semibold text-tick-text">
          Settings
        </span>
        <button
          onClick={onClose}
          aria-label="Back to tasks"
          title="Back to tasks"
          className="no-drag col-start-3 grid h-7 w-7 place-items-center justify-self-end rounded-md text-sm text-tick-text-dim transition-colors hover:bg-[#EAEAED] hover:text-tick-text"
        >
          ✕
        </button>
      </div>

      <div
        className="scrollable no-drag flex-1 space-y-4 overflow-y-auto bg-[#FAFAFC] p-3"
        style={{ scrollbarGutter: 'stable' }}
      >
        <div>
          <label className="text-tick-text-dim text-xs mb-1 block">Task File</label>
          <div className="flex items-center gap-2">
            <span className="flex-1 truncate rounded-md border border-[#DDE1E8] bg-white px-2 py-1 text-xs text-tick-text">
              {currentPath}
            </span>
            <button
              onClick={handleChangeFile}
              className="rounded-md border border-[#DDE1E8] bg-white px-2 py-1 text-xs font-medium text-tick-text transition-colors hover:bg-[#EAEAED] hover:text-tick-text"
            >
              Change
            </button>
          </div>
        </div>

        <div>
          <label className="text-tick-text-dim text-xs mb-1 block">Agent</label>
          <div className="flex items-center gap-2">
            <select
              value={agentConfig.provider}
              onChange={(event) => handleAgentProviderChange(event.target.value as AgentProvider)}
              className="flex-1 rounded-md border border-[#DDE1E8] bg-white px-2 py-1 text-xs text-tick-text outline-none transition-colors hover:border-[#C9CED8] hover:bg-white focus:border-tick-accent/50 focus:bg-white"
            >
              {agentProviderOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              onClick={handleAgentConfigSave}
              disabled={isSavingAgent}
              className="rounded-md bg-tick-accent px-2 py-1 text-xs font-medium text-white transition-all hover:bg-tick-accent-strong active:scale-95 disabled:opacity-40"
            >
              Save
            </button>
          </div>

          {agentConfig.provider === 'custom' && (
            <input
              type="text"
              value={agentConfig.customCommand}
              onChange={(event) => handleAgentCommandChange(event.target.value)}
              placeholder="codex --model gpt-5"
              className="mt-2 w-full rounded-md border border-[#DDE1E8] bg-white px-2 py-1 text-xs text-tick-text outline-none transition-colors placeholder:text-tick-text-dim hover:border-[#C9CED8] hover:bg-white focus:border-tick-accent/50 focus:bg-white"
            />
          )}

          {agentConfig.provider === 'claude' && (
            <>
              <label className="mt-2 flex cursor-pointer items-center justify-between rounded-md border border-[#DDE1E8] bg-white px-2 py-1.5 transition-colors hover:bg-[#EAEAED]">
                <span className="text-xs font-medium text-tick-text">Skip permissions</span>
                <input
                  type="checkbox"
                  checked={agentConfig.skipPermissions}
                  disabled={isSavingAgent}
                  onChange={(event) => void handleSkipPermissionsChange(event.target.checked)}
                  className="h-4 w-4 accent-tick-accent"
                />
              </label>
              <p className="mt-1 text-tick-text-dim text-xs">
                跳过权限确认（--dangerously-skip-permissions），无人值守批量执行用。
              </p>
            </>
          )}

          {agentError && (
            <p className="mt-1 text-red-500 text-xs">{agentError}</p>
          )}
        </div>

        <div>
          <label className="text-tick-text-dim text-xs mb-1 block">Terminal</label>
          <label className="flex cursor-pointer items-center justify-between rounded-md border border-[#DDE1E8] bg-white px-2 py-1.5 transition-colors hover:bg-[#EAEAED]">
            <span className="text-xs font-medium text-tick-text">Key controls</span>
            <input
              type="checkbox"
              checked={agentConfig.showTerminalControls}
              disabled={isSavingAgent}
              onChange={(event) => void handleTerminalControlsChange(event.target.checked)}
              className="h-4 w-4 accent-tick-accent"
            />
          </label>
        </div>

        <div>
          <label className="text-tick-text-dim text-xs mb-1 block">Agent Process</label>
          <button
            onClick={() => {
              void store.restartAgent();
            }}
            className="w-full rounded-md border border-[#DDE1E8] bg-white px-2 py-1.5 text-xs font-medium text-tick-text transition-colors hover:bg-[#EAEAED] hover:border-[#C9CED8]"
          >
            Restart Agent
          </button>
          <p className="mt-1 text-tick-text-dim text-xs">
            切换模型/配置（如 ccswitch）后点此重启 agent 使新配置生效。
          </p>
        </div>

        <div>
          <label className="text-tick-text-dim text-xs mb-1 block">App</label>
          <button
            onClick={async () => {
              await window.electronAPI.restartApp();
            }}
            className="w-full rounded-md border border-[#DDE1E8] bg-white px-2 py-1.5 text-xs font-medium text-tick-text transition-colors hover:bg-[#EAEAED] hover:border-[#C9CED8]"
          >
            Restart App
          </button>
        </div>

        <div>
          <label className="text-tick-text-dim text-xs mb-1 block">Notification Sound</label>
          <div className="flex items-center gap-2">
            <select
              value={notificationSound}
              onChange={(e) => handleNotificationSoundChange(e.target.value)}
              className="flex-1 rounded-md border border-[#DDE1E8] bg-white px-2 py-1 text-xs text-tick-text outline-none transition-colors hover:border-[#C9CED8] hover:bg-white focus:border-tick-accent/50 focus:bg-white"
            >
              {systemSounds.map((sound) => (
                <option key={sound} value={sound}>
                  {sound.replace('.aiff', '')}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handlePreviewSound}
              className="rounded-md border border-[#DDE1E8] bg-white px-2 py-1 text-xs font-medium text-tick-text transition-colors hover:bg-[#EAEAED]"
            >
              ▶
            </button>
          </div>
        </div>

        <div>
          <label className="text-tick-text-dim text-xs mb-1 block">Shortcut</label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={shortcut}
              onChange={(e) => setShortcut(e.target.value)}
              placeholder="e.g. Cmd+Shift+T"
              className="flex-1 rounded-md border border-[#DDE1E8] bg-white px-2 py-1 text-xs text-tick-text outline-none transition-colors hover:border-[#C9CED8] hover:bg-white focus:border-tick-accent/50 focus:bg-white"
            />
            <button
              onClick={handleShortcutChange}
              className="rounded-md bg-tick-accent px-2 py-1 text-xs font-medium text-white transition-all hover:bg-tick-accent-strong active:scale-95"
            >
              Save
            </button>
          </div>
        </div>

        {saved && (
          <p className="rounded-md bg-tick-accent/10 px-2 py-1 text-xs text-tick-accent">✓ Saved</p>
        )}
      </div>
    </div>
  );
}
