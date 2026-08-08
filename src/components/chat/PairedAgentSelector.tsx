// ABOUTME: Role-scoped agent dropdown for Planner + Runner threads (#3748).
// ABOUTME: Lists every offered agent from live availability and swaps that role's inner session.

import type { Component } from "solid-js";
import { createMemo, createSignal, For, Show } from "solid-js";
import { FloatingSelectorMenu } from "@/components/chat/FloatingSelectorMenu";
import {
  allowsClaudeAgent,
  allowsCodexAgent,
  allowsGeminiAgent,
  allowsGrokAgent,
  allowsLmStudioAgent,
  allowsSerenPrivateAgent,
  allowsSerenPublicModels,
} from "@/services/organization-policy";
import type { PairedRole, PairedRoleAgentType } from "@/services/providers";
import { type ActiveSession, agentStore } from "@/stores/agent.store";
import { authStore } from "@/stores/auth.store";

interface Props {
  session: ActiveSession | null;
  pairedRole: PairedRole;
}

const ROLE_LABELS: Record<PairedRole, string> = {
  planner: "Planner",
  executor: "Runner",
};

interface RoleAgentOption {
  id: PairedRoleAgentType;
  label: string;
  glyph: string;
}

const ROLE_AGENT_OPTIONS: readonly RoleAgentOption[] = [
  { id: "claude-code", label: "Claude Code", glyph: "\u{1F916}" },
  { id: "codex", label: "Codex", glyph: "⚡" },
  { id: "gemini", label: "Antigravity", glyph: "✨" },
  { id: "grok", label: "Grok", glyph: "\u{1D54F}" },
  { id: "lmstudio", label: "LM Studio", glyph: "\u{1F5A5}️" },
  { id: "seren", label: "Seren Agent", glyph: "\u{1F4AC}" },
  { id: "seren-private", label: "Seren Private Models", glyph: "\u{1F512}" },
];

export const PairedAgentSelector: Component<Props> = (props) => {
  const [isOpen, setIsOpen] = createSignal(false);
  let dropdownRef: HTMLDivElement | undefined;

  const paired = () => props.session?.paired ?? null;
  const roleStatus = () => paired()?.[props.pairedRole] ?? null;

  // The Claude + Codex wrapper keeps its fixed pairing; only the general
  // Planner + Runner thread offers the swap.
  const isSwappable = () => paired()?.agentType === "planner-runner";
  const isIdle = () => (paired()?.state ?? "idle") === "idle";

  const offeredOptions = createMemo(() => {
    const policy = authStore.privateChatPolicy;
    const nativeAvailable = new Map(
      agentStore.availableAgents.map((agent) => [agent.type, agent.available]),
    );
    return ROLE_AGENT_OPTIONS.filter((option) => {
      switch (option.id) {
        case "claude-code":
          return allowsClaudeAgent(policy);
        case "codex":
          return allowsCodexAgent(policy);
        case "gemini":
          return allowsGeminiAgent(policy);
        case "grok":
          return allowsGrokAgent(policy);
        case "lmstudio":
          return (
            allowsLmStudioAgent(policy) &&
            nativeAvailable.get("lmstudio") !== false
          );
        case "seren":
          return authStore.isAuthenticated && allowsSerenPublicModels(policy);
        case "seren-private":
          return authStore.isAuthenticated && allowsSerenPrivateAgent(policy);
      }
    });
  });

  const currentOption = () => {
    const agentType = roleStatus()?.agentType;
    return ROLE_AGENT_OPTIONS.find((option) => option.id === agentType) ?? null;
  };

  const selectAgent = (agentType: PairedRoleAgentType) => {
    setIsOpen(false);
    if (agentType === roleStatus()?.agentType) return;
    void agentStore.setPairedAgent(
      props.pairedRole,
      agentType,
      props.session?.info.id,
    );
  };

  return (
    <Show when={isSwappable()}>
      <div class="relative" ref={dropdownRef}>
        <button
          type="button"
          data-testid={`paired-agent-selector-${props.pairedRole}`}
          class="flex items-center gap-1.5 px-2 py-1 bg-surface-2 border border-surface-3 rounded-md text-xs text-foreground cursor-pointer hover:bg-surface-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={() => setIsOpen(!isOpen())}
          disabled={!isIdle()}
          title={
            isIdle()
              ? `Change ${ROLE_LABELS[props.pairedRole].toLowerCase()} agent`
              : "Wait for the current turn to finish before changing agents"
          }
        >
          <span class="font-medium max-w-[200px] truncate">
            {ROLE_LABELS[props.pairedRole]} ·{" "}
            {currentOption()?.label ?? roleStatus()?.label ?? "Agent"}
          </span>
          <svg
            class={`w-3 h-3 text-muted-foreground transition-transform ${isOpen() ? "rotate-180" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            role="img"
            aria-label="Toggle dropdown"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M19 9l-7 7-7-7"
            />
          </svg>
        </button>

        <FloatingSelectorMenu
          open={isOpen()}
          anchor={() => dropdownRef}
          onRequestClose={() => setIsOpen(false)}
          class="w-64 max-w-[calc(100vw-2rem)]"
        >
          <div class="px-3 py-2 border-b border-surface-2 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
            {ROLE_LABELS[props.pairedRole]} Agent
          </div>
          <For each={offeredOptions()}>
            {(option) => (
              <button
                type="button"
                data-testid={`paired-agent-option-${props.pairedRole}-${option.id}`}
                class={`w-full text-left px-3 py-2 border-b border-surface-2 last:border-b-0 transition-colors cursor-pointer hover:bg-surface-2 ${
                  option.id === roleStatus()?.agentType ? "bg-surface-2" : ""
                }`}
                onClick={() => selectAgent(option.id)}
              >
                <div class="flex items-center gap-2">
                  <span class="text-[14px] w-[20px] text-center shrink-0">
                    {option.glyph}
                  </span>
                  <span class="text-sm text-foreground font-medium flex-1">
                    {option.label}
                  </span>
                  <Show when={option.id === roleStatus()?.agentType}>
                    <svg
                      class="w-4 h-4 text-green-500 flex-shrink-0"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                      role="img"
                      aria-label="Selected"
                    >
                      <path
                        fill-rule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                        clip-rule="evenodd"
                      />
                    </svg>
                  </Show>
                </div>
              </button>
            )}
          </For>
        </FloatingSelectorMenu>
      </div>
    </Show>
  );
};
