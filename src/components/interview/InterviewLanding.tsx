// ABOUTME: General Seren Employee intake landing fed by the public role catalog.
// ABOUTME: Opens from first launch, deep links, and fallback desktop entry points.

import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  onMount,
  Show,
} from "solid-js";
import {
  catalogAssetUrl,
  clusterLabel,
  resolveInterviewEmployeeSlug,
} from "@/components/interview/interviewLandingModel";

export {
  CLOSE_INTERVIEW_LANDING_EVENT,
  type InterviewLandingEventDetail,
  OPEN_INTERVIEW_LANDING_EVENT,
} from "@/components/interview/interviewLandingEvents";

import { employeeCatalogStore } from "@/stores/employee-catalog.store";

interface InterviewLandingProps {
  initialEmployeeSlug?: string | null;
  onClose?: () => void;
  onSelectEmployee?: (employeeSlug: string) => void;
  onStartInterview?: (employeeSlug: string | null) => void;
}

export const InterviewLanding: Component<InterviewLandingProps> = (props) => {
  const [selectedSlug, setSelectedSlug] = createSignal<string | null>(null);
  const [started, setStarted] = createSignal(false);

  onMount(() => {
    if (
      employeeCatalogStore.lastLoadedAt === null &&
      !employeeCatalogStore.loading
    ) {
      void employeeCatalogStore.refresh();
    }
  });

  const employees = createMemo(() =>
    [...employeeCatalogStore.employees].sort((left, right) => {
      if (left.cluster !== right.cluster) {
        return left.cluster.localeCompare(right.cluster);
      }
      return left.seniority - right.seniority;
    }),
  );

  createEffect(() => {
    setSelectedSlug(
      resolveInterviewEmployeeSlug(employees(), props.initialEmployeeSlug),
    );
    setStarted(false);
  });

  const selectedEmployee = createMemo(() => {
    const slug = selectedSlug();
    if (!slug) return null;
    return employeeCatalogStore.bySlug(slug) ?? null;
  });

  const handleStartInterview = () => {
    setStarted(true);
    props.onStartInterview?.(selectedSlug());
  };

  return (
    <section
      class="flex h-full min-h-0 bg-background text-foreground"
      data-testid="interview-landing"
    >
      <aside class="w-[320px] shrink-0 border-r border-border/80 bg-surface-0/80 px-6 py-6 overflow-y-auto">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <p class="m-0 text-[10px] font-semibold uppercase tracking-[0.16em] text-primary/80">
              Seren Employee Intake
            </p>
            <h1 class="mt-3 mb-0 text-[26px] leading-[1.05] font-semibold tracking-normal text-foreground">
              Pick the employee you want to hire.
            </h1>
          </div>
          <Show when={props.onClose}>
            <button
              type="button"
              class="h-8 w-8 shrink-0 rounded-md border border-border/80 bg-transparent text-muted-foreground hover:text-foreground hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/70"
              aria-label="Close interview landing"
              onClick={props.onClose}
            >
              ×
            </button>
          </Show>
        </div>

        <div class="mt-7 border-t border-border/70 pt-5">
          <p class="m-0 text-[12px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Selected Role
          </p>
          <Show
            when={selectedEmployee()}
            fallback={
              <div class="mt-3 rounded-md border border-dashed border-border/80 bg-surface-1/50 px-3 py-3 text-[13px] leading-snug text-muted-foreground">
                No role selected
              </div>
            }
          >
            {(employee) => (
              <div class="mt-3 overflow-hidden rounded-md border border-border/80 bg-surface-1">
                <img
                  src={catalogAssetUrl(employee().imageUrl)}
                  alt=""
                  class="h-32 w-full object-cover"
                  loading="lazy"
                />
                <div class="px-3 py-3">
                  <p class="m-0 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                    {clusterLabel(employee())}
                  </p>
                  <h2 class="mt-1 mb-0 text-[15px] font-semibold leading-tight text-foreground">
                    {employee().title}
                  </h2>
                  <p class="mt-2 mb-0 text-[12px] leading-snug text-muted-foreground">
                    {employee().tagline}
                  </p>
                </div>
              </div>
            )}
          </Show>
        </div>

        <button
          type="button"
          class="mt-5 flex h-10 w-full items-center justify-center rounded-md border border-primary/70 bg-primary text-[13px] font-semibold text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-2 disabled:text-muted-foreground"
          disabled={employeeCatalogStore.loading || employees().length === 0}
          data-testid="start-employee-interview"
          onClick={handleStartInterview}
        >
          Start Interview
        </button>
        <Show when={started()}>
          <p
            class="mt-3 mb-0 text-[12px] leading-snug text-success"
            data-testid="interview-started-state"
          >
            Intake queued for Seren Employee customization.
          </p>
        </Show>
      </aside>

      <div class="min-w-0 flex-1 overflow-y-auto px-6 py-6">
        <div class="flex items-end justify-between gap-4 border-b border-border/70 pb-4">
          <div class="min-w-0">
            <p class="m-0 text-[12px] font-medium text-muted-foreground">
              Public catalog
            </p>
            <h2 class="mt-1 mb-0 text-[18px] font-semibold text-foreground">
              {employees().length} executive roles
            </h2>
          </div>
          <button
            type="button"
            class="h-8 rounded-md border border-border/80 bg-transparent px-3 text-[12px] font-medium text-muted-foreground hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/70 disabled:cursor-wait disabled:opacity-60"
            disabled={employeeCatalogStore.loading}
            onClick={() => void employeeCatalogStore.refresh()}
          >
            Refresh
          </button>
        </div>

        <Show when={employeeCatalogStore.error}>
          <div
            class="mt-4 rounded-md border border-status-error/40 bg-status-error/10 px-3 py-2 text-[13px] text-status-error"
            role="alert"
          >
            {employeeCatalogStore.error}
          </div>
        </Show>

        <Show
          when={!employeeCatalogStore.loading || employees().length > 0}
          fallback={
            <div class="mt-8 text-[13px] text-muted-foreground">
              Loading employee catalog...
            </div>
          }
        >
          <div
            class="mt-5 grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3"
            data-testid="interview-role-grid"
          >
            <For each={employees()}>
              {(employee) => {
                const active = () => selectedSlug() === employee.slug;
                return (
                  <button
                    type="button"
                    class="group overflow-hidden rounded-md border border-border/80 bg-surface-1 text-left transition-colors hover:border-primary/50 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                    classList={{
                      "border-primary/80 bg-primary-muted": active(),
                    }}
                    data-testid="interview-role-option"
                    aria-pressed={active()}
                    onClick={() => {
                      setSelectedSlug(employee.slug);
                      props.onSelectEmployee?.(employee.slug);
                    }}
                  >
                    <div class="relative h-24 overflow-hidden bg-surface-2">
                      <img
                        src={catalogAssetUrl(employee.imageUrl)}
                        alt=""
                        class="h-full w-full object-cover opacity-90 transition-transform duration-200 group-hover:scale-[1.03]"
                        loading="lazy"
                      />
                      <Show when={employee.featured}>
                        <span class="absolute left-2 top-2 rounded-sm bg-background/80 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-primary">
                          Featured
                        </span>
                      </Show>
                    </div>
                    <div class="px-3 py-3">
                      <p class="m-0 truncate text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                        {clusterLabel(employee)}
                      </p>
                      <h3 class="mt-1 mb-0 text-[14px] font-semibold leading-tight text-foreground">
                        {employee.title}
                      </h3>
                      <p class="mt-2 line-clamp-2 min-h-[34px] text-[12px] leading-snug text-muted-foreground">
                        {employee.tagline}
                      </p>
                    </div>
                  </button>
                );
              }}
            </For>
          </div>
        </Show>
      </div>
    </section>
  );
};
