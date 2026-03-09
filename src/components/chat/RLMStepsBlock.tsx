// ABOUTME: Collapsible block showing per-chunk processing steps for RLM responses.
// ABOUTME: Renders only when a message was produced by Recursive Language Model processing.

import type { Component } from "solid-js";
import { createSignal, For } from "solid-js";
import type { RLMStepData } from "@/types/conversation";
import "./RLMStepsBlock.css";

interface RLMStepsBlockProps {
  steps: RLMStepData[];
}

export const RLMStepsBlock: Component<RLMStepsBlockProps> = (props) => {
  const [isExpanded, setIsExpanded] = createSignal(false);

  return (
    <div class="rlm-steps-block">
      <button
        type="button"
        class="rlm-steps-header"
        onClick={() => setIsExpanded(!isExpanded())}
      >
        <svg
          class="rlm-steps-icon"
          viewBox="0 0 20 20"
          fill="currentColor"
          role="img"
          aria-label="Recursive processing"
        >
          <path
            fill-rule="evenodd"
            d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z"
            clip-rule="evenodd"
          />
        </svg>
        <span class="rlm-steps-label">
          Processed in {props.steps.length} section
          {props.steps.length !== 1 ? "s" : ""}
        </span>
        <svg
          class={`rlm-steps-chevron ${isExpanded() ? "rlm-steps-chevron--open" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          role="img"
          aria-label={isExpanded() ? "Collapse" : "Expand"}
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {isExpanded() && (
        <div class="rlm-steps-body">
          <For each={props.steps}>
            {(step) => (
              <div class="rlm-step">
                <span class="rlm-step-label">
                  Section {step.index + 1} of {step.total}
                </span>
                <p class="rlm-step-summary">{step.summary}</p>
              </div>
            )}
          </For>
        </div>
      )}
    </div>
  );
};
