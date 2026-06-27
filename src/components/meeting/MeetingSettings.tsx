// ABOUTME: Meeting Mode + dictation settings: templates, vocabulary, routing, auto-detect.
// ABOUTME: Reads/writes settingsStore; follows the global theme with no state pills.

import { createSignal, For, onMount, Show } from "solid-js";
import {
  listMeetingTemplates,
  type MeetingTemplate,
} from "@/services/meetings";
import { settingsStore } from "@/stores/settings.store";

function FieldLabel(props: { children: string; hint?: string }) {
  return (
    <div class="mb-1.5">
      <div class="text-[13px] font-medium text-foreground">
        {props.children}
      </div>
      <Show when={props.hint}>
        <div class="text-[11px] text-muted-foreground">{props.hint}</div>
      </Show>
    </div>
  );
}

export function MeetingSettings() {
  const [builtins, setBuiltins] = createSignal<MeetingTemplate[]>([]);
  const [vocabTerm, setVocabTerm] = createSignal("");
  const [tplName, setTplName] = createSignal("");
  const [tplPrompt, setTplPrompt] = createSignal("");

  onMount(async () => {
    try {
      setBuiltins(await listMeetingTemplates());
    } catch {
      setBuiltins([]);
    }
  });

  const customTemplates = () => settingsStore.get("meetingCustomTemplates");
  const vocabulary = () => settingsStore.get("voiceCustomVocabulary");

  const allTemplates = () => [...builtins(), ...customTemplates()];

  const addVocab = () => {
    const term = vocabTerm().trim();
    if (!term || vocabulary().includes(term)) return;
    settingsStore.set("voiceCustomVocabulary", [...vocabulary(), term]);
    setVocabTerm("");
  };

  const removeVocab = (term: string) => {
    settingsStore.set(
      "voiceCustomVocabulary",
      vocabulary().filter((t) => t !== term),
    );
  };

  const addCustomTemplate = () => {
    const name = tplName().trim();
    const prompt = tplPrompt().trim();
    if (!name || !prompt) return;
    const id = `custom-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    if (allTemplates().some((t) => t.id === id)) return;
    settingsStore.set("meetingCustomTemplates", [
      ...customTemplates(),
      { id, name, prompt },
    ]);
    setTplName("");
    setTplPrompt("");
  };

  const removeCustomTemplate = (id: string) => {
    settingsStore.set(
      "meetingCustomTemplates",
      customTemplates().filter((t) => t.id !== id),
    );
  };

  return (
    <div class="min-h-0 flex-1 overflow-auto p-5 max-w-[640px] space-y-6">
      <section>
        <FieldLabel hint="Used for new meetings and notes generation.">
          Default template
        </FieldLabel>
        <select
          class="h-8 w-full rounded-md border border-border bg-surface-1 px-2 text-[13px] text-foreground focus:outline-none focus:border-primary/60"
          value={settingsStore.get("meetingTemplateId")}
          onChange={(event) =>
            settingsStore.set("meetingTemplateId", event.currentTarget.value)
          }
        >
          <For each={allTemplates()}>
            {(template) => <option value={template.id}>{template.name}</option>}
          </For>
        </select>
      </section>

      <section>
        <FieldLabel hint="A template is a prompt that shapes the note structure.">
          Custom templates
        </FieldLabel>
        <div class="space-y-2">
          <For each={customTemplates()}>
            {(template) => (
              <div class="flex items-start gap-2 rounded-md border border-border bg-surface-0/50 p-2">
                <div class="min-w-0 flex-1">
                  <div class="text-[13px] text-foreground">{template.name}</div>
                  <div class="text-[11px] text-muted-foreground truncate">
                    {template.prompt}
                  </div>
                </div>
                <button
                  type="button"
                  class="text-[11px] text-muted-foreground hover:text-destructive"
                  onClick={() => removeCustomTemplate(template.id)}
                >
                  Remove
                </button>
              </div>
            )}
          </For>
          <input
            class="h-8 w-full rounded-md border border-border bg-surface-1 px-2.5 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/60"
            placeholder="Template name"
            value={tplName()}
            onInput={(event) => setTplName(event.currentTarget.value)}
          />
          <textarea
            class="min-h-[60px] w-full rounded-md border border-border bg-surface-1 px-2.5 py-1.5 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/60"
            placeholder="Prompt: what the notes should capture…"
            value={tplPrompt()}
            onInput={(event) => setTplPrompt(event.currentTarget.value)}
          />
          <button
            type="button"
            class="h-8 px-3 rounded-md border border-primary/40 bg-primary/10 text-[12px] text-primary hover:bg-primary/15"
            onClick={addCustomTemplate}
          >
            Add template
          </button>
        </div>
      </section>

      <section>
        <FieldLabel hint="Terms the cleanup engine should keep and spell correctly (shared with dictation).">
          Custom vocabulary
        </FieldLabel>
        <div class="flex flex-wrap gap-1.5 mb-2">
          <For each={vocabulary()}>
            {(term) => (
              <span class="inline-flex items-center gap-1 rounded border border-border bg-surface-1 px-1.5 py-0.5 text-[12px] text-foreground">
                {term}
                <button
                  type="button"
                  class="text-muted-foreground hover:text-destructive"
                  onClick={() => removeVocab(term)}
                  aria-label={`Remove ${term}`}
                >
                  ×
                </button>
              </span>
            )}
          </For>
        </div>
        <div class="flex gap-2">
          <input
            class="h-8 flex-1 rounded-md border border-border bg-surface-1 px-2.5 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/60"
            placeholder="Add a term (e.g. Affinity)"
            value={vocabTerm()}
            onInput={(event) => setVocabTerm(event.currentTarget.value)}
            onKeyDown={(event) => event.key === "Enter" && addVocab()}
          />
          <button
            type="button"
            class="h-8 px-3 rounded-md border border-border bg-surface-2 text-[12px] text-foreground hover:bg-surface-3"
            onClick={addVocab}
          >
            Add
          </button>
        </div>
      </section>

      <section>
        <label class="flex items-center justify-between gap-3 cursor-pointer">
          <FieldLabel hint="Clean up filler and punctuation in notes and dictation.">
            AI cleanup
          </FieldLabel>
          <input
            type="checkbox"
            class="h-4 w-4 accent-primary"
            checked={settingsStore.get("voiceCleanupEnabled")}
            onChange={(event) =>
              settingsStore.set(
                "voiceCleanupEnabled",
                event.currentTarget.checked,
              )
            }
          />
        </label>
      </section>

      <section>
        <label class="flex items-center justify-between gap-3 cursor-pointer">
          <FieldLabel hint="Recognized call apps (Zoom, Meet, Teams, Discord, …) auto-start recording after your one-time audio-permission acknowledgment. Other detected microphone activity only shows a titlebar prompt — you choose whether to record.">
            Auto-detect meetings
          </FieldLabel>
          <input
            type="checkbox"
            class="h-4 w-4 accent-primary"
            checked={settingsStore.get("meetingAutoDetectEnabled")}
            onChange={(event) =>
              settingsStore.set(
                "meetingAutoDetectEnabled",
                event.currentTarget.checked,
              )
            }
          />
        </label>
      </section>
    </div>
  );
}
