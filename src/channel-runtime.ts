/**
 * Plugin-scoped runtime store. The host gateway hands us a runtime object when
 * the channel boots (`setRuntime` on the entry); inbound dispatch helpers read
 * it back at turn time via `getRuntime`. We don't faithfully type the runtime
 * shape — the surface is huge and version-shifting — and the host enforces the
 * real contract. Loose typing here is intentional.
 */

import { createPluginRuntimeStore } from "openclaw/plugin-sdk/channel-core";

export type VoiceChatRuntime = unknown;

const store = createPluginRuntimeStore<VoiceChatRuntime>({
  pluginId: "voice-chat",
  errorMessage:
    "voice-chat runtime not initialized — host gateway has not called setRuntime yet.",
});

export const setVoiceChatRuntime: (rt: VoiceChatRuntime) => void = store.setRuntime;
export const clearVoiceChatRuntime: () => void = store.clearRuntime;
export const tryGetVoiceChatRuntime: () => VoiceChatRuntime | null = store.tryGetRuntime;
export const getVoiceChatRuntime: () => VoiceChatRuntime = store.getRuntime;
