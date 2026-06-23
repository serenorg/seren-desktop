// ABOUTME: Acknowledgement UI for distributing recorded skills.
// ABOUTME: Keeps recording publication gates consistent across skill modals.

import type { Component } from "solid-js";
import type { Skill, SkillVisibility } from "@/lib/skills";

export function isRecordedSkill(skill: Pick<Skill, "tags">): boolean {
  return skill.tags.includes("recorded");
}

export function isPublicSkillVisibility(
  visibility: SkillVisibility | null | undefined,
): boolean {
  return visibility === "public" || visibility === "paid";
}

interface RecordedSkillPublishAcknowledgementProps {
  description: string;
  reviewAcknowledged: boolean;
  permanenceAcknowledged: boolean;
  onReviewAcknowledgedChange: (value: boolean) => void;
  onPermanenceAcknowledgedChange: (value: boolean) => void;
  disabled?: boolean;
  reviewLabel?: string;
  permanenceLabel?: string;
}

export const RecordedSkillPublishAcknowledgement: Component<
  RecordedSkillPublishAcknowledgementProps
> = (props) => {
  return (
    <section class="flex flex-col gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-3">
      <div class="flex flex-col gap-0.5">
        <span class="text-[12px] font-medium text-foreground">
          Recorded skill review
        </span>
        <span class="text-[11px] text-muted-foreground">
          {props.description}
        </span>
      </div>
      <label class="flex items-start gap-2 text-[12px] text-foreground">
        <input
          type="checkbox"
          class="mt-0.5 h-3.5 w-3.5 accent-primary"
          checked={props.reviewAcknowledged}
          onChange={(event) =>
            props.onReviewAcknowledgedChange(event.currentTarget.checked)
          }
          disabled={props.disabled}
        />
        <span>
          {props.reviewLabel ??
            "I reviewed the generated steps, assumptions, inputs, and redaction warnings."}
        </span>
      </label>
      <label class="flex items-start gap-2 text-[12px] text-foreground">
        <input
          type="checkbox"
          class="mt-0.5 h-3.5 w-3.5 accent-primary"
          checked={props.permanenceAcknowledged}
          onChange={(event) =>
            props.onPermanenceAcknowledgedChange(event.currentTarget.checked)
          }
          disabled={props.disabled}
        />
        <span>
          {props.permanenceLabel ??
            "I understand public or paid recording skills, including Git author attribution, may be copied, synced, and cached after publishing."}
        </span>
      </label>
    </section>
  );
};
