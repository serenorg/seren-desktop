// ABOUTME: Modal wizard to deploy a new virtual employee via the seren-agent publisher.
// ABOUTME: Single-page form with mode/identity/skills/model fields plus collapsible advanced.

import {
  type Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type { AgentAssetFile } from "@/api/seren-agent";
import { deriveSlug, gradientFor, initialFor } from "@/lib/employees/avatar";
import { buildEmployeeFilesPatch } from "@/lib/employees/bundle-patch";
import {
  hasHiddenPathSegment,
  type ImportFileEntry,
  type InstructionSlot,
  importPathForFile,
  normalizeResourcePath,
  routeFiles,
  slotForFilename,
} from "@/lib/employees/import";
import {
  buildEmployeeInstructionFiles,
  extractInstructionSections,
} from "@/lib/employees/instructions";
import {
  buildEmployeePolicyReviewSummary,
  type EmployeePolicyReviewSummary,
} from "@/lib/employees/review-summary";
import {
  CONNECTOR_ACCESS_OPTIONS,
  type ConnectorAccessMode,
  connectorAccessModeFromToolRefs,
  firstRemoteHttpToolRef,
  mergeConnectorAccessToolRefs,
  mergeRemoteHttpToolRef,
  type RemoteHttpToolRef,
  remoteHttpToolRefDraftError,
  sameToolRefs,
} from "@/lib/employees/tool-refs";
import type {
  EmployeeApprovalPolicy,
  EmployeeDetail,
  EmployeeMode,
  EmployeeModelPolicy,
  EmployeePatch,
  EmployeeToolPreset,
  ModelChoice,
  NewEmployeeInput,
} from "@/lib/employees/types";
import { employees as svc } from "@/services/employees";
import { employeeStore } from "@/stores/employees.store";

type ModeOption = { value: EmployeeMode; title: string; sub: string };

const MODES: ModeOption[] = [
  {
    value: "always_on",
    title: "On-call",
    sub: "Always available, you converse",
  },
  { value: "cron", title: "Scheduled", sub: "Runs on a cron schedule" },
  { value: "job", title: "On-demand", sub: "Manual trigger only" },
];

const POLICIES: { value: EmployeeModelPolicy; label: string }[] = [
  { value: "fast", label: "Fast" },
  { value: "balanced", label: "Balanced" },
  { value: "deep", label: "Deep" },
];

const REMOTE_HTTP_METHODS: RemoteHttpToolRef["method"][] = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
];

const REMOTE_HTTP_AUTHS: RemoteHttpToolRef["auth_mode"][] = [
  "none",
  "bearer",
  "api_key",
  "basic",
  "mtls",
];

const TOOL_PRESETS: { value: EmployeeToolPreset; label: string }[] = [
  { value: "live_data", label: "Live data" },
  { value: "publisher_actions", label: "Publisher actions" },
  { value: "database", label: "Database" },
];

const DEFAULT_LIMITS = {
  maxIterations: 4,
  maxToolCallsPerRun: 4,
  maxTimeoutSeconds: 120,
  maxToolOutputChars: 6000,
  contextBudgetTokens: 24000,
};

const MAX_AGENT_INSTRUCTION_BYTES = 1024 * 1024;
const MAX_AGENT_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_AGENT_BUNDLE_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_AGENT_BUNDLE_FILES = 256;

function sameStringSet(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

interface CreateEmployeeModalProps {
  onClose: () => void;
  onCreated: (employeeId: string) => void;
  /**
   * When provided, the modal opens in edit mode: fields are prefilled and
   * submission calls update() instead of deploy(). Slug and mode are
   * immutable in edit mode (the backend update spec does not expose them).
   */
  employee?: EmployeeDetail;
}

interface BrowserFileEntry {
  file: File;
  path: string;
}

interface CollectedImportFiles {
  entries: ImportFileEntry[];
  skipped: string[];
}

interface FileSystemEntryLike {
  name: string;
  fullPath?: string;
  isFile: boolean;
  isDirectory: boolean;
}

interface FileSystemFileEntryLike extends FileSystemEntryLike {
  file: (
    success: (file: File) => void,
    error?: (error: DOMException) => void,
  ) => void;
}

interface FileSystemDirectoryEntryLike extends FileSystemEntryLike {
  createReader: () => {
    readEntries: (
      success: (entries: FileSystemEntryLike[]) => void,
      error?: (error: DOMException) => void,
    ) => void;
  };
}

type DataTransferItemWithEntry = DataTransferItem & {
  getAsEntry?: () => FileSystemEntryLike | null;
  webkitGetAsEntry?: () => FileSystemEntryLike | null;
};

export const CreateEmployeeModal: Component<CreateEmployeeModalProps> = (
  props,
) => {
  const editing = () => props.employee !== undefined;
  const initial = props.employee;

  const [name, setName] = createSignal(initial?.name ?? "");
  const [slug, setSlug] = createSignal(initial?.slug ?? "");
  // In edit mode the slug is immutable; treat it as already-touched so we
  // never auto-derive over it.
  const [slugTouched, setSlugTouched] = createSignal(initial !== undefined);
  const [mode, setMode] = createSignal<EmployeeMode>(
    initial?.mode ?? "always_on",
  );
  const [cronSchedule, setCronSchedule] = createSignal(
    initial?.cronSchedule ?? "0 * * * *",
  );
  const [cronTimezone, setCronTimezone] = createSignal(
    initial?.cronTimezone ?? "UTC",
  );
  const initialSections = extractInstructionSections(initial?.instructions);
  const [skillInstructions, setSkillInstructions] = createSignal(
    initialSections.skill,
  );
  const [identity, setIdentity] = createSignal(initialSections.identity);
  const [soul, setSoul] = createSignal(initialSections.soul);
  const [agents, setAgents] = createSignal(initialSections.agents);
  const [user, setUser] = createSignal(initialSections.user);
  const [memory, setMemory] = createSignal(initialSections.memory);
  const [tools, setTools] = createSignal(initialSections.tools);
  const [heartbeat, setHeartbeat] = createSignal(initialSections.heartbeat);
  const [evalInstructions, setEvalInstructions] = createSignal(
    initialSections.eval,
  );
  const [assets, setAssets] = createSignal<AgentAssetFile[]>(
    initial?.bundle.assets ?? [],
  );
  const [modelChoice, setModelChoice] = createSignal<ModelChoice>(
    initial?.modelChoice ?? "standard",
  );
  const [modelPolicy, setModelPolicy] = createSignal<EmployeeModelPolicy>(
    initial?.modelPolicy ?? "balanced",
  );
  const [modelId, setModelId] = createSignal(initial?.modelId ?? "");
  const [showAdvanced, setShowAdvanced] = createSignal(false);
  const [approvalPolicy, setApprovalPolicy] =
    createSignal<EmployeeApprovalPolicy>(
      initial?.approvalPolicy ?? "read_only",
    );
  const [toolPresets, setToolPresets] = createSignal<EmployeeToolPreset[]>(
    initial?.toolPresets && initial.toolPresets.length > 0
      ? initial.toolPresets
      : ["live_data"],
  );
  const [connectorAccess, setConnectorAccess] =
    createSignal<ConnectorAccessMode>(
      connectorAccessModeFromToolRefs(initial?.toolRefs ?? []),
    );
  const initialRemoteHttp = firstRemoteHttpToolRef(initial?.toolRefs ?? []);
  const remoteHttpRefCount = createMemo(
    () =>
      (props.employee?.toolRefs ?? []).filter(
        (ref) => ref.kind === "remote_http",
      ).length,
  );
  const [remoteHttpEnabled, setRemoteHttpEnabled] = createSignal(
    Boolean(initialRemoteHttp),
  );
  const [remoteHttpName, setRemoteHttpName] = createSignal(
    initialRemoteHttp?.name ?? "",
  );
  const [remoteHttpEndpoint, setRemoteHttpEndpoint] = createSignal(
    initialRemoteHttp?.endpoint ?? "",
  );
  const [remoteHttpMethod, setRemoteHttpMethod] = createSignal<
    RemoteHttpToolRef["method"]
  >(initialRemoteHttp?.method ?? "post");
  const [remoteHttpAuthMode, setRemoteHttpAuthMode] = createSignal<
    RemoteHttpToolRef["auth_mode"]
  >(initialRemoteHttp?.auth_mode ?? "none");
  const [remoteHttpRequiresApproval, setRemoteHttpRequiresApproval] =
    createSignal(initialRemoteHttp?.require_approval ?? false);
  const [maxIterations, setMaxIterations] = createSignal(
    initial?.maxIterations ?? DEFAULT_LIMITS.maxIterations,
  );
  const [maxToolCalls, setMaxToolCalls] = createSignal(
    initial?.maxToolCallsPerRun ?? DEFAULT_LIMITS.maxToolCallsPerRun,
  );
  const [maxTimeout, setMaxTimeout] = createSignal(
    initial?.maxTimeoutSeconds ?? DEFAULT_LIMITS.maxTimeoutSeconds,
  );
  const [maxToolOutput, setMaxToolOutput] = createSignal(
    initial?.maxToolOutputChars ?? DEFAULT_LIMITS.maxToolOutputChars,
  );
  const [contextBudget, setContextBudget] = createSignal(
    initial?.contextBudgetTokens ?? DEFAULT_LIMITS.contextBudgetTokens,
  );

  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [dragging, setDragging] = createSignal(false);
  const [importNotice, setImportNotice] = createSignal<string | null>(null);
  const [folderPickerSupported, setFolderPickerSupported] = createSignal(false);

  let fileInputRef: HTMLInputElement | undefined;
  let folderInputRef: HTMLInputElement | undefined;

  const setSection = (slot: InstructionSlot, body: string) => {
    if (slot === "skill") setSkillInstructions(body);
    else if (slot === "identity") setIdentity(body);
    else if (slot === "soul") setSoul(body);
    else if (slot === "agents") setAgents(body);
    else if (slot === "user") setUser(body);
    else if (slot === "memory") setMemory(body);
    else if (slot === "tools") setTools(body);
    else if (slot === "heartbeat") setHeartbeat(body);
    else if (slot === "eval") setEvalInstructions(body);
  };

  const sectionBody = (slot: InstructionSlot) => {
    if (slot === "skill") return skillInstructions();
    if (slot === "identity") return identity();
    if (slot === "soul") return soul();
    if (slot === "agents") return agents();
    if (slot === "user") return user();
    if (slot === "memory") return memory();
    if (slot === "tools") return tools();
    if (slot === "heartbeat") return heartbeat();
    return evalInstructions();
  };

  const readFileBytes = (file: File): Promise<Uint8Array> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () =>
        resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.onerror = () => reject(reader.error ?? new Error("Read failed"));
      reader.readAsArrayBuffer(file);
    });

  const bytesToBase64 = (bytes: Uint8Array) => {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  };

  const sha256Hex = async (bytes: Uint8Array) => {
    if (!globalThis.crypto?.subtle) return undefined;
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  };

  const decodeInstructionText = (bytes: Uint8Array): string =>
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);

  const summarizeNames = (names: string[]) => {
    const shown = names.slice(0, 3).join(", ");
    const remaining = names.length - 3;
    return remaining > 0 ? `${shown}, +${remaining} more` : shown;
  };

  const fileFromEntry = (
    entry: FileSystemFileEntryLike,
  ): Promise<BrowserFileEntry> =>
    new Promise((resolve, reject) => {
      entry.file(
        (file) =>
          resolve({
            file,
            path: (entry.fullPath ?? entry.name).replace(/^\/+/, ""),
          }),
        reject,
      );
    });

  const readDirectoryEntries = async (
    entry: FileSystemDirectoryEntryLike,
  ): Promise<FileSystemEntryLike[]> => {
    const reader = entry.createReader();
    const entries: FileSystemEntryLike[] = [];

    for (;;) {
      const batch = await new Promise<FileSystemEntryLike[]>(
        (resolve, reject) => reader.readEntries(resolve, reject),
      );
      if (batch.length === 0) break;
      entries.push(...batch);
    }

    return entries;
  };

  const collectEntryFiles = async (
    entry: FileSystemEntryLike,
  ): Promise<BrowserFileEntry[]> => {
    if (entry.isFile) {
      return [await fileFromEntry(entry as FileSystemFileEntryLike)];
    }
    if (!entry.isDirectory) return [];

    const children = await readDirectoryEntries(
      entry as FileSystemDirectoryEntryLike,
    );
    const nested = await Promise.all(children.map(collectEntryFiles));
    return nested.reduce<BrowserFileEntry[]>(
      (acc, childFiles) => acc.concat(childFiles),
      [],
    );
  };

  // Read every file the user dragged in, including files nested in dropped
  // directories when the browser exposes directory entries.
  const collectDroppedFiles = async (
    items: DataTransferItemList | null,
    fallback: FileList | null,
  ): Promise<CollectedImportFiles> => {
    const entries: ImportFileEntry[] = [];
    const skipped: string[] = [];
    let importedBytes = 0;

    const files: BrowserFileEntry[] = [];
    if (items) {
      for (const item of Array.from(items)) {
        if (item.kind !== "file") continue;
        const itemWithEntry = item as DataTransferItemWithEntry;
        const entry =
          itemWithEntry.webkitGetAsEntry?.() ?? itemWithEntry.getAsEntry?.();
        if (entry) {
          files.push(...(await collectEntryFiles(entry)));
        } else {
          const f = item.getAsFile();
          if (f) files.push({ file: f, path: importPathForFile(f) });
        }
      }
    }
    if (files.length === 0 && fallback) {
      for (const f of Array.from(fallback)) {
        files.push({ file: f, path: importPathForFile(f) });
      }
    }

    const visibleFiles: BrowserFileEntry[] = [];
    for (const fileEntry of files) {
      if (hasHiddenPathSegment(fileEntry.path)) {
        skipped.push(`${fileEntry.path} (hidden file)`);
      } else {
        visibleFiles.push(fileEntry);
      }
    }
    const selectedFiles = visibleFiles.slice(0, MAX_AGENT_BUNDLE_FILES);
    const overFileLimit = visibleFiles.length - selectedFiles.length;
    if (overFileLimit > 0) {
      skipped.push(
        `${overFileLimit} additional file${
          overFileLimit === 1 ? "" : "s"
        } (file limit)`,
      );
    }

    for (const { file, path } of selectedFiles) {
      const name = path;
      const slot = slotForFilename(name);
      const maxBytes = slot
        ? MAX_AGENT_INSTRUCTION_BYTES
        : MAX_AGENT_ASSET_BYTES;
      if (file.size > maxBytes) {
        skipped.push(`${name} (over ${Math.floor(maxBytes / 1024 / 1024)} MB)`);
        continue;
      }
      if (importedBytes + file.size > MAX_AGENT_BUNDLE_TOTAL_BYTES) {
        skipped.push(`${name} (bundle limit)`);
        continue;
      }
      try {
        const bytes = await readFileBytes(file);
        const body = slot ? decodeInstructionText(bytes) : undefined;
        const sha256 = await sha256Hex(bytes);
        importedBytes += bytes.byteLength;
        entries.push({
          name,
          body,
          contentBase64: bytesToBase64(bytes),
          contentType: file.type || null,
          sha256,
        });
      } catch (err) {
        skipped.push(`${name} (read failed)`);
        console.warn(`Failed to read ${name}:`, err);
      }
    }
    return { entries, skipped };
  };

  const mergeAssets = (resources: AgentAssetFile[]) => {
    let replaced = 0;
    setAssets((prev) => {
      const byPath = new Map(
        prev.map((asset) => [
          normalizeResourcePath(asset.path) ?? asset.path,
          asset,
        ]),
      );
      for (const resource of resources) {
        const key = normalizeResourcePath(resource.path) ?? resource.path;
        if (byPath.has(key)) replaced += 1;
        byPath.set(key, resource);
      }
      return Array.from(byPath.values());
    });
    return replaced;
  };

  const applyImportedFiles = (
    entries: ImportFileEntry[],
    sourceLabel: string,
    skipped: string[] = [],
  ) => {
    if (entries.length === 0) {
      const skippedText =
        skipped.length > 0 ? ` Skipped: ${summarizeNames(skipped)}.` : "";
      setImportNotice(
        `No readable files in that ${sourceLabel}.${skippedText}`,
      );
      return;
    }

    const result = routeFiles(entries);
    let appliedProfile = false;
    const importedName = result.skillMetadata?.name?.trim();
    if (!editing() && importedName && name().trim().length === 0) {
      setName(importedName);
      appliedProfile = true;
    }
    const importedSlug = deriveSlug(result.skillMetadata?.slug ?? "");
    if (!editing() && importedSlug && !slugTouched()) {
      setSlug(importedSlug);
      setSlugTouched(true);
      appliedProfile = true;
    }

    let replacedSections = 0;
    for (const [slot, body] of Object.entries(result.sections)) {
      if (typeof body === "string") {
        if (sectionBody(slot as InstructionSlot).trim().length > 0) {
          replacedSections += 1;
        }
        setSection(slot as InstructionSlot, body);
      }
    }
    const replacedResources = mergeAssets(result.resources);
    clearError();

    const filledCount = Object.keys(result.sections).length;
    const parts: string[] = [];
    if (appliedProfile) {
      parts.push("Filled employee profile");
    }
    if (filledCount > 0) {
      parts.push(
        `Filled ${filledCount} section${filledCount === 1 ? "" : "s"}`,
      );
    }
    if (result.resources.length > 0) {
      parts.push(
        `Added ${result.resources.length} resource${
          result.resources.length === 1 ? "" : "s"
        }`,
      );
    }
    if (replacedResources > 0) {
      parts.push(
        `Replaced ${replacedResources} existing resource${
          replacedResources === 1 ? "" : "s"
        }`,
      );
    }
    if (replacedSections > 0) {
      parts.push(
        `Replaced ${replacedSections} section${
          replacedSections === 1 ? "" : "s"
        }`,
      );
    }
    if (result.collided.length > 0) {
      parts.push(
        `${result.collided.length} instruction collision${
          result.collided.length === 1 ? "" : "s"
        }: ${summarizeNames(result.collided)}`,
      );
    }
    if (result.ignored.length > 0) {
      parts.push(
        `${result.ignored.length} ignored: ${summarizeNames(result.ignored)}`,
      );
    }
    if (skipped.length > 0) {
      parts.push(`${skipped.length} skipped: ${summarizeNames(skipped)}`);
    }
    if (!skillInstructions().trim() && result.sections.skill === undefined) {
      parts.push("add SKILL.md instructions to finish");
    }
    setImportNotice(parts.length > 0 ? parts.join(" - ") : null);
  };

  const handleDrop = async (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    if (submitting()) return;

    const { entries, skipped } = await collectDroppedFiles(
      event.dataTransfer?.items ?? null,
      event.dataTransfer?.files ?? null,
    );
    applyImportedFiles(entries, "drop", skipped);
  };

  const handleFilePicker = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    if (submitting() || !input.files) {
      input.value = "";
      return;
    }
    try {
      const { entries, skipped } = await collectDroppedFiles(null, input.files);
      applyImportedFiles(entries, "selection", skipped);
    } finally {
      // Reset so picking the same file or folder twice still fires onChange.
      input.value = "";
    }
  };

  const openFilePicker = () => {
    if (submitting()) return;
    fileInputRef?.click();
  };

  const openFolderPicker = () => {
    if (submitting()) return;
    if (!folderPickerSupported()) return;
    folderInputRef?.click();
  };

  const handleDragOver = (event: DragEvent) => {
    if (!event.dataTransfer) return;
    if (submitting()) return;
    const types = event.dataTransfer.types;
    // Older browsers expose `types` as DOMStringList rather than a plain
    // array; both support iteration via Array.from, but guard against the
    // (rare) case where the spec exposes nothing at all.
    if (!types) return;
    const hasFiles = Array.from(types).includes("Files");
    if (!hasFiles) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    if (!dragging()) setDragging(true);
  };

  const handleDragLeave = (event: DragEvent) => {
    if (event.currentTarget === event.target) setDragging(false);
  };

  let nameInputRef: HTMLInputElement | undefined;

  const clearError = () => {
    if (error() !== null) setError(null);
  };

  const [privateModels] = createResource(
    () => (modelChoice() === "private" ? "load" : null),
    async () => {
      try {
        return await svc.listPrivateModels();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return [];
      }
    },
  );

  createEffect(() => {
    const list = privateModels();
    if (modelChoice() !== "private") return;
    if (!list || list.length === 0) return;
    if (modelId()) return;
    const recommended = list.find((m) => m.recommended) ?? list[0];
    setModelId(recommended.model_id);
  });

  const handleDocumentKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !submitting()) {
      event.preventDefault();
      props.onClose();
    }
  };

  onMount(() => {
    const testInput = document.createElement("input");
    const supportsFolderPicker = "webkitdirectory" in testInput;
    setFolderPickerSupported(supportsFolderPicker);
    if (supportsFolderPicker) {
      folderInputRef?.setAttribute("webkitdirectory", "");
      folderInputRef?.setAttribute("directory", "");
    }
    requestAnimationFrame(() => nameInputRef?.focus());
    document.addEventListener("keydown", handleDocumentKeydown);
  });

  onCleanup(() => {
    document.removeEventListener("keydown", handleDocumentKeydown);
  });

  const effectiveSlug = createMemo(() => {
    if (slugTouched()) return slug();
    return deriveSlug(name());
  });

  const remoteHttpToolRef = createMemo<RemoteHttpToolRef | undefined>(() => {
    if (!remoteHttpEnabled()) return undefined;
    const endpoint = remoteHttpEndpoint().trim();
    return {
      ...(initialRemoteHttp ?? {
        kind: "remote_http",
        permitted_actions: [
          {
            action: "execute",
            capability: { kind: "all" },
          },
        ],
      }),
      name: remoteHttpName().trim(),
      endpoint,
      method: remoteHttpMethod(),
      auth_mode: remoteHttpAuthMode(),
      require_approval: remoteHttpRequiresApproval(),
    };
  });

  const remoteHttpDraftError = createMemo(() => {
    return remoteHttpToolRefDraftError({
      enabled: remoteHttpEnabled(),
      name: remoteHttpName(),
      endpoint: remoteHttpEndpoint(),
      method: remoteHttpMethod(),
      existingRefs: props.employee?.toolRefs ?? [],
      editingRef: initialRemoteHttp,
    });
  });

  const submitDisabledReason = createMemo(() => {
    if (submitting()) return "";
    if (name().trim().length === 0) return "Name is required.";
    if (effectiveSlug().length === 0) return "Slug is required.";
    if (skillInstructions().trim().length === 0)
      return "SKILL.md instructions are required.";
    if (mode() === "cron" && cronSchedule().trim().length === 0)
      return "Cron schedule is required.";
    if (modelChoice() === "private" && modelId().trim().length === 0)
      return "Private model id is required.";
    if (remoteHttpDraftError()) return remoteHttpDraftError();
    return "";
  });

  const canSubmit = createMemo(
    () => !submitting() && submitDisabledReason() === "",
  );

  const buildInstructions = () => {
    return buildEmployeeInstructionFiles({
      name: name(),
      slug: effectiveSlug(),
      skill: skillInstructions(),
      identity: identity(),
      soul: soul(),
      agents: agents(),
      user: user(),
      memory: memory(),
      tools: tools(),
      heartbeat: heartbeat(),
      eval: evalInstructions(),
    });
  };

  const buildExistingBundle = () => ({
    ...props.employee?.bundle,
    instructions: buildInstructions(),
    assets: assets(),
  });

  const currentToolRefs = createMemo(() =>
    mergeRemoteHttpToolRef(
      mergeConnectorAccessToolRefs(
        props.employee?.toolRefs ?? [],
        connectorAccess(),
      ),
      remoteHttpToolRef(),
    ),
  );

  const policyReview = createMemo(() =>
    buildEmployeePolicyReviewSummary({
      approvalPolicy: approvalPolicy(),
      toolPresets: toolPresets(),
      runtimePolicy: props.employee?.runtimePolicy ?? null,
      toolRefs: currentToolRefs(),
      guardrails: props.employee?.guardrails ?? [],
    }),
  );

  const hasNonFileEditChanges = () => {
    const employee = props.employee;
    if (!employee) return true;
    if (name().trim() !== employee.name) return true;
    if (employee.mode === "cron") {
      if (cronSchedule().trim() !== (employee.cronSchedule ?? "")) return true;
      if (cronTimezone().trim() !== (employee.cronTimezone ?? "UTC"))
        return true;
    }
    if (modelChoice() !== employee.modelChoice) return true;
    if (modelChoice() === "standard") {
      if (modelPolicy() !== (employee.modelPolicy ?? "balanced")) return true;
    }
    if (modelChoice() === "private") {
      if (modelId().trim() !== (employee.modelId ?? "")) return true;
    }
    if (!sameStringSet(toolPresets(), employee.toolPresets)) return true;
    if (!sameToolRefs(currentToolRefs(), employee.toolRefs)) return true;
    if (approvalPolicy() !== employee.approvalPolicy) return true;
    if (
      maxIterations() !==
      (employee.maxIterations ?? DEFAULT_LIMITS.maxIterations)
    )
      return true;
    if (
      maxToolCalls() !==
      (employee.maxToolCallsPerRun ?? DEFAULT_LIMITS.maxToolCallsPerRun)
    )
      return true;
    if (
      maxTimeout() !==
      (employee.maxTimeoutSeconds ?? DEFAULT_LIMITS.maxTimeoutSeconds)
    )
      return true;
    if (
      maxToolOutput() !==
      (employee.maxToolOutputChars ?? DEFAULT_LIMITS.maxToolOutputChars)
    )
      return true;
    if (
      contextBudget() !==
      (employee.contextBudgetTokens ?? DEFAULT_LIMITS.contextBudgetTokens)
    )
      return true;
    return false;
  };

  const toggleToolPreset = (preset: EmployeeToolPreset) => {
    setToolPresets((prev) =>
      prev.includes(preset)
        ? prev.filter((p) => p !== preset)
        : [...prev, preset],
    );
  };

  const handleSubmit = async () => {
    if (!canSubmit()) return;
    setSubmitting(true);
    setError(null);
    try {
      const limits = {
        maxIterations: maxIterations(),
        maxToolCallsPerRun: maxToolCalls(),
        maxTimeoutSeconds: maxTimeout(),
        maxToolOutputChars: maxToolOutput(),
        contextBudgetTokens: contextBudget(),
      };
      let summary: Awaited<ReturnType<typeof svc.deploy>>;
      if (props.employee) {
        const bundle = buildExistingBundle();
        const filesPatch = buildEmployeeFilesPatch(
          props.employee.bundle,
          bundle,
        );
        if (hasNonFileEditChanges()) {
          const toolRefsChanged = !sameToolRefs(
            currentToolRefs(),
            props.employee.toolRefs,
          );
          const patch: EmployeePatch = {
            name: name().trim(),
            // Mode is immutable on update; cron fields only flow when the
            // existing mode is cron.
            mode: props.employee.mode,
            cronSchedule:
              props.employee.mode === "cron"
                ? cronSchedule().trim()
                : undefined,
            cronTimezone:
              props.employee.mode === "cron"
                ? cronTimezone().trim()
                : undefined,
            instructions: bundle.instructions ?? [],
            bundle,
            modelChoice: modelChoice(),
            modelPolicy:
              modelChoice() === "standard" ? modelPolicy() : undefined,
            modelId: modelChoice() === "private" ? modelId().trim() : undefined,
            toolPresets: toolPresets(),
            toolRefs: toolRefsChanged ? currentToolRefs() : undefined,
            approvalPolicy: approvalPolicy(),
            limits,
          };
          summary = await svc.update(props.employee.id, patch);
        } else if (filesPatch) {
          summary = await svc.patchFiles(props.employee.id, filesPatch);
        } else {
          summary = props.employee;
        }
      } else {
        const instructions = buildInstructions();
        const input: NewEmployeeInput = {
          name: name().trim(),
          slug: effectiveSlug(),
          mode: mode(),
          cronSchedule: mode() === "cron" ? cronSchedule().trim() : undefined,
          cronTimezone: mode() === "cron" ? cronTimezone().trim() : undefined,
          instructions,
          bundle: {
            instructions,
            assets: assets(),
          },
          modelChoice: modelChoice(),
          modelPolicy: modelChoice() === "standard" ? modelPolicy() : undefined,
          modelId: modelChoice() === "private" ? modelId().trim() : undefined,
          toolPresets: toolPresets(),
          toolRefs: currentToolRefs(),
          approvalPolicy: approvalPolicy(),
          limits,
        };
        summary = await svc.deploy(input);
      }
      employeeStore.upsert(summary);
      void employeeStore.refresh();
      if (props.employee) {
        void employeeStore.loadDetail(summary.id);
      }
      props.onCreated(summary.id);
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleBackdropClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget && !submitting()) props.onClose();
  };

  return (
    <div
      class="fixed inset-0 bg-black/60 flex items-center justify-center z-[1000] animate-[fadeIn_0.15s_ease-out]"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-employee-title"
    >
      <div class="bg-popover border border-border rounded-lg w-[560px] max-w-[92vw] max-h-[88vh] overflow-y-auto shadow-xl animate-[slideUp_0.2s_ease-out]">
        <div class="flex justify-between items-center py-4 px-5 border-b border-border sticky top-0 bg-popover z-10">
          <h2
            id="create-employee-title"
            class="m-0 text-base font-semibold text-foreground"
          >
            {editing()
              ? `Edit ${props.employee?.name ?? "employee"}`
              : "New employee"}
          </h2>
          <button
            type="button"
            class="bg-transparent border-none text-muted-foreground text-2xl leading-none cursor-pointer py-1 px-2 rounded transition-all duration-150 hover:bg-muted hover:text-foreground disabled:opacity-50"
            onClick={props.onClose}
            disabled={submitting()}
            title="Close"
            aria-label="Close"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </div>

        <div class="p-5">
          <Show when={error()}>
            <div
              class="py-2.5 px-3 mb-4 bg-destructive/20 text-destructive rounded text-[13px]"
              role="alert"
            >
              {error()}
            </div>
          </Show>

          {/* Avatar + Name */}
          <div class="flex items-center gap-3 mb-4">
            <div
              class="w-10 h-10 rounded-md flex items-center justify-center text-white font-bold text-base flex-none"
              style={{ background: gradientFor(effectiveSlug() || "_") }}
              aria-hidden="true"
            >
              {initialFor(name() || "?")}
            </div>
            <div class="flex-1 min-w-0">
              <label
                for="employee-name"
                class="block mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70"
              >
                Name
              </label>
              <input
                id="employee-name"
                ref={nameInputRef}
                type="text"
                class="w-full py-2 px-3 bg-card text-foreground border border-border rounded text-sm transition-colors duration-150 focus:outline-none focus:border-primary"
                value={name()}
                onInput={(e) => {
                  setName(e.currentTarget.value);
                  clearError();
                }}
                placeholder="e.g. Research Assistant"
                disabled={submitting()}
              />
            </div>
          </div>

          {/* Slug */}
          <div class="mb-4">
            <label
              for="employee-slug"
              class="block mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70"
            >
              Slug
            </label>
            <input
              id="employee-slug"
              type="text"
              class="w-full py-2 px-3 bg-card text-foreground border border-border rounded text-sm font-mono transition-colors duration-150 focus:outline-none focus:border-primary disabled:opacity-60"
              value={effectiveSlug()}
              onInput={(e) => {
                setSlug(deriveSlug(e.currentTarget.value));
                setSlugTouched(true);
                clearError();
              }}
              placeholder="e.g. research-assistant"
              disabled={submitting() || editing()}
              readOnly={editing()}
              aria-describedby="employee-slug-help"
            />
            <div
              id="employee-slug-help"
              class="mt-1 text-[10.5px] text-muted-foreground/80"
            >
              <Show
                when={!editing()}
                fallback="Slug is fixed for the lifetime of the deployment."
              >
                Lowercase letters, numbers, and hyphens. Auto-derived from name
                until edited.
              </Show>
            </div>
          </div>

          {/* Mode */}
          <div class="mb-4">
            <div
              id="employee-mode-label"
              class="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70"
            >
              What kind of employee?
            </div>
            <div
              class="grid grid-cols-3 gap-2"
              role="radiogroup"
              aria-labelledby="employee-mode-label"
              aria-describedby={editing() ? "employee-mode-help" : undefined}
            >
              <For each={MODES}>
                {(option) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={mode() === option.value}
                    class="text-left p-2.5 rounded-md border bg-card transition-all duration-100 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    classList={{
                      "border-primary bg-primary/[0.08]":
                        mode() === option.value,
                      "border-border hover:border-border/90 hover:bg-surface-2":
                        mode() !== option.value && !editing(),
                    }}
                    onClick={() => {
                      if (editing()) return;
                      setMode(option.value);
                    }}
                    disabled={submitting() || editing()}
                  >
                    <div class="text-[12.5px] font-semibold text-foreground">
                      {option.title}
                    </div>
                    <div class="text-[10.5px] text-muted-foreground leading-tight mt-0.5">
                      {option.sub}
                    </div>
                  </button>
                )}
              </For>
            </div>
            <Show when={editing()}>
              <div
                id="employee-mode-help"
                class="mt-1.5 text-[10.5px] text-muted-foreground/80"
              >
                Mode is fixed for the lifetime of the deployment.
              </div>
            </Show>
          </div>

          {/* Cron schedule (only when scheduled) */}
          <Show when={mode() === "cron"}>
            <div class="mb-4 grid grid-cols-2 gap-3">
              <div>
                <label
                  for="employee-cron"
                  class="block mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70"
                >
                  Cron schedule
                </label>
                <input
                  id="employee-cron"
                  type="text"
                  class="w-full py-2 px-3 bg-card text-foreground border border-border rounded text-sm font-mono focus:outline-none focus:border-primary"
                  value={cronSchedule()}
                  onInput={(e) => setCronSchedule(e.currentTarget.value)}
                  placeholder="0 * * * *"
                  disabled={submitting()}
                />
              </div>
              <div>
                <label
                  for="employee-tz"
                  class="block mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70"
                >
                  Timezone
                </label>
                <input
                  id="employee-tz"
                  type="text"
                  class="w-full py-2 px-3 bg-card text-foreground border border-border rounded text-sm font-mono focus:outline-none focus:border-primary"
                  value={cronTimezone()}
                  onInput={(e) => setCronTimezone(e.currentTarget.value)}
                  placeholder="UTC"
                  disabled={submitting()}
                />
              </div>
            </div>
          </Show>

          {/* Drop zone: accept SKILL.md / IDENTITY.md / ... files or a folder
              containing them. Files route by canonical filename. A hidden file
              input backs the "Browse files" button so keyboard users can
              attach without dragging. */}
          <div class="mb-4">
            <label
              for="employee-drop-input"
              class="block mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70"
            >
              Import instruction files
              <span class="font-normal opacity-70 normal-case tracking-normal">
                {" "}
                (optional)
              </span>
            </label>
            <input
              ref={fileInputRef}
              id="employee-drop-input"
              type="file"
              multiple
              class="sr-only"
              onChange={handleFilePicker}
              disabled={submitting()}
            />
            <input
              ref={folderInputRef}
              type="file"
              multiple
              class="sr-only"
              tabIndex={-1}
              aria-label="Import instruction folder"
              onChange={handleFilePicker}
              disabled={submitting()}
            />
            <div
              id="employee-drop"
              class="w-full py-3 px-3 bg-card text-foreground border border-dashed rounded text-[12px] leading-relaxed transition-colors"
              classList={{
                "border-primary/60 bg-primary/[0.06]":
                  dragging() && !submitting(),
                "border-border": !dragging() || submitting(),
                "opacity-60": submitting(),
              }}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <div class="text-muted-foreground">
                Drop a <code class="font-mono text-[11.5px]">SKILL.md</code>
                {", "}
                <code class="font-mono text-[11.5px]">IDENTITY.md</code>
                {", "}
                <code class="font-mono text-[11.5px]">SOUL.md</code>
                {", "}
                <code class="font-mono text-[11.5px]">AGENTS.md</code>
                {", "}
                <code class="font-mono text-[11.5px]">USER.md</code>
                {", "}
                <code class="font-mono text-[11.5px]">MEMORY.md</code>
                {", "}
                <code class="font-mono text-[11.5px]">TOOLS.md</code>
                {", or "}
                <code class="font-mono text-[11.5px]">HEARTBEAT.md</code>
                {", or "}
                <code class="font-mono text-[11.5px]">EVAL.md</code>
                {
                  " file - or a folder containing instruction and resource files. Files are routed by canonical filename; other files are packaged as resources."
                }
              </div>
              <Show when={assets().length > 0}>
                <div class="mt-2 text-[11.5px] text-muted-foreground">
                  {assets().length} resource
                  {assets().length === 1 ? "" : "s"} packaged:
                  <ul class="mt-1 list-disc pl-4 space-y-0.5">
                    <For each={assets().slice(0, 5)}>
                      {(asset) => (
                        <li class="font-mono text-[11px] truncate">
                          {asset.path}
                        </li>
                      )}
                    </For>
                  </ul>
                  <Show when={assets().length > 5}>
                    <div class="mt-0.5">
                      +{assets().length - 5} more resource
                      {assets().length - 5 === 1 ? "" : "s"}
                    </div>
                  </Show>
                </div>
              </Show>
              <div class="mt-2">
                <button
                  type="button"
                  class="text-[11.5px] font-medium text-primary underline-offset-2 hover:underline focus:outline-none focus-visible:underline disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={openFilePicker}
                  disabled={submitting()}
                >
                  Browse files...
                </button>
                <Show when={folderPickerSupported()}>
                  <button
                    type="button"
                    class="ml-3 text-[11.5px] font-medium text-primary underline-offset-2 hover:underline focus:outline-none focus-visible:underline disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={openFolderPicker}
                    disabled={submitting()}
                  >
                    Browse folder...
                  </button>
                </Show>
              </div>
              <Show when={importNotice()}>
                <div
                  class="mt-2 text-[11.5px] text-primary"
                  role="status"
                  aria-live="polite"
                >
                  {importNotice()}
                </div>
              </Show>
            </div>
          </div>

          {/* SKILL.md is the required instruction file for an employee. */}
          <div class="mb-4">
            <label
              for="employee-skill-instructions"
              class="block mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70"
            >
              SKILL.md
            </label>
            <textarea
              id="employee-skill-instructions"
              class="w-full min-h-[110px] py-2 px-3 bg-card text-foreground border border-border rounded text-sm leading-relaxed resize-y focus:outline-none focus:border-primary"
              value={skillInstructions()}
              onInput={(e) => {
                setSkillInstructions(e.currentTarget.value);
                clearError();
              }}
              placeholder="Senior advisor with decades of perspective. Calm authority, plain language, and long-horizon thinking."
              disabled={submitting()}
            />
          </div>

          {/* Model */}
          <div class="mb-4">
            <div class="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
              Model
            </div>
            <div
              class="inline-flex bg-card border border-border rounded-md overflow-hidden mb-2"
              role="radiogroup"
              aria-label="Model source"
            >
              <button
                type="button"
                role="radio"
                aria-checked={modelChoice() === "standard"}
                class="px-3 py-1.5 text-[12px] font-medium transition-colors"
                classList={{
                  "bg-primary/[0.12] text-primary":
                    modelChoice() === "standard",
                  "text-muted-foreground hover:text-foreground":
                    modelChoice() !== "standard",
                }}
                onClick={() => setModelChoice("standard")}
                disabled={submitting()}
              >
                Standard
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={modelChoice() === "private"}
                class="px-3 py-1.5 text-[12px] font-medium transition-colors"
                classList={{
                  "bg-primary/[0.12] text-primary": modelChoice() === "private",
                  "text-muted-foreground hover:text-foreground":
                    modelChoice() !== "private",
                }}
                onClick={() => setModelChoice("private")}
                disabled={submitting()}
              >
                Private
              </button>
            </div>

            <Show when={modelChoice() === "standard"}>
              <div
                class="flex gap-1.5 flex-wrap"
                role="radiogroup"
                aria-label="Model speed/quality"
              >
                <For each={POLICIES}>
                  {(option) => (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={modelPolicy() === option.value}
                      class="px-3 py-1 rounded-full text-[11.5px] font-medium border transition-colors"
                      classList={{
                        "bg-primary/[0.12] border-primary/40 text-primary":
                          modelPolicy() === option.value,
                        "bg-card border-border text-muted-foreground hover:text-foreground":
                          modelPolicy() !== option.value,
                      }}
                      onClick={() => setModelPolicy(option.value)}
                      disabled={submitting()}
                    >
                      {option.label}
                    </button>
                  )}
                </For>
              </div>
            </Show>

            <Show when={modelChoice() === "private"}>
              <Show
                when={!privateModels.loading}
                fallback={
                  <div class="text-[12px] text-muted-foreground italic">
                    Loading private models...
                  </div>
                }
              >
                <select
                  class="w-full py-2 px-3 bg-card text-foreground border border-border rounded text-sm focus:outline-none focus:border-primary"
                  value={modelId()}
                  onChange={(e) => setModelId(e.currentTarget.value)}
                  disabled={submitting()}
                >
                  <Show when={(privateModels() ?? []).length === 0}>
                    <option value="">No private models available</option>
                  </Show>
                  <For each={privateModels() ?? []}>
                    {(m) => (
                      <option value={m.model_id}>
                        {m.label}
                        {m.recommended ? " (recommended)" : ""}
                      </option>
                    )}
                  </For>
                </select>
              </Show>
            </Show>
          </div>

          {/* Advanced */}
          <div class="border-t border-border pt-3">
            <button
              type="button"
              class="flex items-center gap-1.5 bg-transparent border-none text-[11.5px] text-muted-foreground hover:text-foreground cursor-pointer p-0"
              aria-expanded={showAdvanced()}
              aria-controls="employee-advanced-panel"
              onClick={() => setShowAdvanced((v) => !v)}
            >
              <span
                class="inline-block transition-transform"
                classList={{ "rotate-90": showAdvanced() }}
                aria-hidden="true"
              >
                {">"}
              </span>
              Advanced
            </button>

            <Show when={showAdvanced()}>
              <div
                id="employee-advanced-panel"
                class="mt-3 grid grid-cols-2 gap-3"
              >
                <div class="col-span-2">
                  <div class="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70 mb-1.5">
                    Tool presets
                  </div>
                  <div
                    class="flex gap-1.5 flex-wrap"
                    role="group"
                    aria-label="Tool presets"
                  >
                    <For each={TOOL_PRESETS}>
                      {(option) => {
                        const active = () =>
                          toolPresets().includes(option.value);
                        return (
                          <button
                            type="button"
                            aria-pressed={active()}
                            class="px-3 py-1 rounded-full text-[11.5px] font-medium border transition-colors"
                            classList={{
                              "bg-primary/[0.12] border-primary/40 text-primary":
                                active(),
                              "bg-card border-border text-muted-foreground hover:text-foreground":
                                !active(),
                            }}
                            onClick={() => toggleToolPreset(option.value)}
                            disabled={submitting()}
                          >
                            {option.label}
                          </button>
                        );
                      }}
                    </For>
                  </div>
                </div>

                <div class="col-span-2">
                  <div class="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70 mb-1.5">
                    Connector access
                  </div>
                  <div
                    class="grid grid-cols-3 gap-2"
                    role="radiogroup"
                    aria-label="Connector access"
                  >
                    <For each={CONNECTOR_ACCESS_OPTIONS}>
                      {(option) => (
                        <button
                          type="button"
                          role="radio"
                          aria-checked={connectorAccess() === option.value}
                          class="text-left p-2.5 rounded-md border bg-card transition-all duration-100 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                          classList={{
                            "border-primary bg-primary/[0.08]":
                              connectorAccess() === option.value,
                            "border-border hover:border-border/90 hover:bg-surface-2":
                              connectorAccess() !== option.value,
                          }}
                          onClick={() => setConnectorAccess(option.value)}
                          disabled={submitting()}
                        >
                          <div class="text-[12.5px] font-semibold text-foreground">
                            {option.title}
                          </div>
                          <div class="text-[10.5px] text-muted-foreground leading-tight mt-0.5">
                            {option.sub}
                          </div>
                        </button>
                      )}
                    </For>
                  </div>
                </div>

                <div class="col-span-2 border border-border rounded-md bg-card p-3 space-y-3">
                  <label class="flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      class="mt-0.5 h-4 w-4 rounded border-border bg-surface-2 text-primary"
                      checked={remoteHttpEnabled()}
                      onChange={(event) =>
                        setRemoteHttpEnabled(event.currentTarget.checked)
                      }
                      disabled={submitting()}
                    />
                    <span>
                      <span class="block text-[12.5px] font-semibold text-foreground">
                        Remote HTTP tool
                      </span>
                      <span class="block text-[10.5px] text-muted-foreground leading-tight mt-0.5">
                        Expose one HTTP(S) endpoint as an execute tool
                      </span>
                    </span>
                  </label>
                  <Show when={remoteHttpEnabled()}>
                    <div class="grid grid-cols-2 gap-3">
                      <label class="block">
                        <span class="block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/70 mb-1">
                          Name
                        </span>
                        <input
                          type="text"
                          value={remoteHttpName()}
                          onInput={(event) =>
                            setRemoteHttpName(event.currentTarget.value)
                          }
                          placeholder="webhook_lookup"
                          disabled={submitting()}
                          class="w-full px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-[12px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:border-primary/50"
                        />
                      </label>
                      <label class="block">
                        <span class="block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/70 mb-1">
                          Method
                        </span>
                        <select
                          value={remoteHttpMethod()}
                          onChange={(event) =>
                            setRemoteHttpMethod(
                              event.currentTarget
                                .value as RemoteHttpToolRef["method"],
                            )
                          }
                          disabled={submitting()}
                          class="w-full px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-[12px] text-foreground focus:outline-none focus:border-primary/50"
                        >
                          <For each={REMOTE_HTTP_METHODS}>
                            {(method) => (
                              <option value={method}>
                                {method.toUpperCase()}
                              </option>
                            )}
                          </For>
                        </select>
                      </label>
                      <label class="block col-span-2">
                        <span class="block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/70 mb-1">
                          Endpoint
                        </span>
                        <input
                          type="url"
                          value={remoteHttpEndpoint()}
                          onInput={(event) =>
                            setRemoteHttpEndpoint(event.currentTarget.value)
                          }
                          placeholder="https://api.example.com/tools/lookup"
                          disabled={submitting()}
                          class="w-full px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-[12px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:border-primary/50"
                        />
                      </label>
                      <label class="block">
                        <span class="block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/70 mb-1">
                          Auth
                        </span>
                        <select
                          value={remoteHttpAuthMode()}
                          onChange={(event) =>
                            setRemoteHttpAuthMode(
                              event.currentTarget
                                .value as RemoteHttpToolRef["auth_mode"],
                            )
                          }
                          disabled={submitting()}
                          class="w-full px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-[12px] text-foreground focus:outline-none focus:border-primary/50"
                        >
                          <For each={REMOTE_HTTP_AUTHS}>
                            {(auth) => (
                              <option value={auth}>
                                {auth.replace("_", " ").toUpperCase()}
                              </option>
                            )}
                          </For>
                        </select>
                      </label>
                      <label class="flex items-center gap-2 pt-5 text-[12px] text-foreground">
                        <input
                          type="checkbox"
                          class="h-4 w-4 rounded border-border bg-surface-2 text-primary"
                          checked={remoteHttpRequiresApproval()}
                          onChange={(event) =>
                            setRemoteHttpRequiresApproval(
                              event.currentTarget.checked,
                            )
                          }
                          disabled={submitting()}
                        />
                        Requires approval
                      </label>
                    </div>
                    <Show when={remoteHttpRefCount() > 1}>
                      <div class="text-[11px] text-muted-foreground">
                        Editing 1 of {remoteHttpRefCount()} remote HTTP refs;
                        other refs are preserved.
                      </div>
                    </Show>
                    <Show when={remoteHttpDraftError()}>
                      <div class="text-[11px] text-destructive">
                        {remoteHttpDraftError()}
                      </div>
                    </Show>
                  </Show>
                </div>

                <div class="col-span-2">
                  <div class="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70 mb-1.5">
                    Approval policy
                  </div>
                  <div
                    class="inline-flex bg-card border border-border rounded-md overflow-hidden"
                    role="radiogroup"
                    aria-label="Approval policy"
                  >
                    <button
                      type="button"
                      role="radio"
                      aria-checked={approvalPolicy() === "read_only"}
                      class="px-3 py-1.5 text-[12px] font-medium transition-colors"
                      classList={{
                        "bg-primary/[0.12] text-primary":
                          approvalPolicy() === "read_only",
                        "text-muted-foreground hover:text-foreground":
                          approvalPolicy() !== "read_only",
                      }}
                      onClick={() => setApprovalPolicy("read_only")}
                      disabled={submitting()}
                    >
                      Read only
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={approvalPolicy() === "allow_mutations"}
                      class="px-3 py-1.5 text-[12px] font-medium transition-colors"
                      classList={{
                        "bg-primary/[0.12] text-primary":
                          approvalPolicy() === "allow_mutations",
                        "text-muted-foreground hover:text-foreground":
                          approvalPolicy() !== "allow_mutations",
                      }}
                      onClick={() => setApprovalPolicy("allow_mutations")}
                      disabled={submitting()}
                    >
                      Allow mutations
                    </button>
                  </div>
                </div>

                <NumField
                  label="Max iterations"
                  value={maxIterations()}
                  onInput={setMaxIterations}
                  disabled={submitting()}
                />
                <NumField
                  label="Max tool calls/run"
                  value={maxToolCalls()}
                  onInput={setMaxToolCalls}
                  disabled={submitting()}
                />
                <NumField
                  label="Timeout (sec)"
                  value={maxTimeout()}
                  onInput={setMaxTimeout}
                  disabled={submitting()}
                />
                <NumField
                  label="Max tool output chars"
                  value={maxToolOutput()}
                  onInput={setMaxToolOutput}
                  disabled={submitting()}
                />
                <NumField
                  label="Context budget tokens"
                  value={contextBudget()}
                  onInput={setContextBudget}
                  disabled={submitting()}
                />

                {/* IDENTITY.md and SOUL.md sit at the bottom of Advanced
                    so frequent toggles (tool presets, approval policy,
                    limits) stay near the top of the tab order. */}
                <div class="col-span-2">
                  <label
                    for="employee-identity"
                    class="block mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70"
                  >
                    IDENTITY.md{" "}
                    <span class="font-normal opacity-70 normal-case tracking-normal">
                      (optional)
                    </span>
                  </label>
                  <textarea
                    id="employee-identity"
                    class="w-full min-h-[90px] py-2 px-3 bg-card text-foreground border border-border rounded text-sm leading-relaxed resize-y focus:outline-none focus:border-primary"
                    value={identity()}
                    onInput={(e) => {
                      setIdentity(e.currentTarget.value);
                      clearError();
                    }}
                    placeholder="Identity, voice, professional background."
                    disabled={submitting()}
                  />
                </div>

                <div class="col-span-2">
                  <label
                    for="employee-soul"
                    class="block mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70"
                  >
                    SOUL.md{" "}
                    <span class="font-normal opacity-70 normal-case tracking-normal">
                      (optional)
                    </span>
                  </label>
                  <textarea
                    id="employee-soul"
                    class="w-full min-h-[90px] py-2 px-3 bg-card text-foreground border border-border rounded text-sm leading-relaxed resize-y focus:outline-none focus:border-primary"
                    value={soul()}
                    onInput={(e) => {
                      setSoul(e.currentTarget.value);
                      clearError();
                    }}
                    placeholder="Values, decision philosophy, deeper convictions."
                    disabled={submitting()}
                  />
                </div>

                <div class="col-span-2">
                  <label
                    for="employee-agents"
                    class="block mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70"
                  >
                    AGENTS.md{" "}
                    <span class="font-normal opacity-70 normal-case tracking-normal">
                      (optional - operating discipline)
                    </span>
                  </label>
                  <textarea
                    id="employee-agents"
                    class="w-full min-h-[90px] py-2 px-3 bg-card text-foreground border border-border rounded text-sm leading-relaxed resize-y focus:outline-none focus:border-primary"
                    value={agents()}
                    onInput={(e) => {
                      setAgents(e.currentTarget.value);
                      clearError();
                    }}
                    placeholder="Tool discipline, memory discipline, scope rules. e.g. Only call publisher_request after a topic_lookup."
                    disabled={submitting()}
                  />
                </div>

                <div class="col-span-2">
                  <label
                    for="employee-user"
                    class="block mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70"
                  >
                    USER.md{" "}
                    <span class="font-normal opacity-70 normal-case tracking-normal">
                      (optional - operator context)
                    </span>
                  </label>
                  <textarea
                    id="employee-user"
                    class="w-full min-h-[90px] py-2 px-3 bg-card text-foreground border border-border rounded text-sm leading-relaxed resize-y focus:outline-none focus:border-primary"
                    value={user()}
                    onInput={(e) => {
                      setUser(e.currentTarget.value);
                      clearError();
                    }}
                    placeholder="Timezone, preferences, access boundaries, and persistent operator context."
                    disabled={submitting()}
                  />
                </div>

                <div class="col-span-2">
                  <label
                    for="employee-tools"
                    class="block mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70"
                  >
                    TOOLS.md{" "}
                    <span class="font-normal opacity-70 normal-case tracking-normal">
                      (optional - tool usage guide)
                    </span>
                  </label>
                  <textarea
                    id="employee-tools"
                    class="w-full min-h-[90px] py-2 px-3 bg-card text-foreground border border-border rounded text-sm leading-relaxed resize-y focus:outline-none focus:border-primary"
                    value={tools()}
                    onInput={(e) => {
                      setTools(e.currentTarget.value);
                      clearError();
                    }}
                    placeholder="When and how to use each declared tool. Complements the tool presets above."
                    disabled={submitting()}
                  />
                </div>

                <div class="col-span-2">
                  <label
                    for="employee-memory"
                    class="block mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70"
                  >
                    MEMORY.md{" "}
                    <span class="font-normal opacity-70 normal-case tracking-normal">
                      (optional - memory policy)
                    </span>
                  </label>
                  <textarea
                    id="employee-memory"
                    class="w-full min-h-[90px] py-2 px-3 bg-card text-foreground border border-border rounded text-sm leading-relaxed resize-y focus:outline-none focus:border-primary"
                    value={memory()}
                    onInput={(e) => {
                      setMemory(e.currentTarget.value);
                      clearError();
                    }}
                    placeholder="What to remember, when to write, in what format. e.g. Persist user preferences after each turn under key 'pref:{topic}'."
                    disabled={submitting()}
                  />
                </div>

                <div class="col-span-2">
                  <label
                    for="employee-heartbeat"
                    class="block mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70"
                  >
                    HEARTBEAT.md{" "}
                    <span class="font-normal opacity-70 normal-case tracking-normal">
                      (optional - stored for scheduled or heartbeat-capable
                      runs)
                    </span>
                  </label>
                  <textarea
                    id="employee-heartbeat"
                    class="w-full min-h-[90px] py-2 px-3 bg-card text-foreground border border-border rounded text-sm leading-relaxed resize-y focus:outline-none focus:border-primary"
                    value={heartbeat()}
                    onInput={(e) => {
                      setHeartbeat(e.currentTarget.value);
                      clearError();
                    }}
                    placeholder="Steps to execute on each scheduled run. e.g. 1. Check the calendar. 2. Summarize anything new. 3. Email if something needs attention."
                    disabled={submitting()}
                  />
                </div>

                <div class="col-span-2">
                  <label
                    for="employee-eval"
                    class="block mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70"
                  >
                    EVAL.md{" "}
                    <span class="font-normal opacity-70 normal-case tracking-normal">
                      (optional - packaged eval cases)
                    </span>
                  </label>
                  <textarea
                    id="employee-eval"
                    class="w-full min-h-[90px] py-2 px-3 bg-card text-foreground border border-border rounded text-sm leading-relaxed resize-y focus:outline-none focus:border-primary"
                    value={evalInstructions()}
                    onInput={(e) => {
                      setEvalInstructions(e.currentTarget.value);
                      clearError();
                    }}
                    placeholder="Smoke or safety eval cases to package with this employee. Eval files are stored with the employee but omitted from the runtime prompt."
                    disabled={submitting()}
                  />
                </div>
              </div>
            </Show>
          </div>

          <PolicyReviewPanel summary={policyReview()} />
        </div>

        <div class="sticky bottom-0 border-t border-border bg-popover py-4 px-5">
          <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Show
              when={submitDisabledReason()}
              fallback={<span class="hidden sm:block" aria-hidden="true" />}
            >
              <span
                id="employee-submit-reason"
                class="min-w-0 truncate text-[12px] text-muted-foreground"
                role="status"
              >
                {submitDisabledReason()}
              </span>
            </Show>

            <div class="flex shrink-0 items-center justify-end gap-3">
              <button
                type="button"
                class="inline-flex h-9 min-w-[88px] shrink-0 items-center justify-center whitespace-nowrap rounded border border-border bg-transparent px-4 text-[13px] font-medium text-foreground transition-all duration-150 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                onClick={props.onClose}
                disabled={submitting()}
              >
                Cancel
              </button>
              <button
                type="button"
                class="inline-flex h-9 min-w-[132px] shrink-0 items-center justify-center whitespace-nowrap rounded border border-primary bg-primary px-4 text-[13px] font-medium text-primary-foreground transition-all duration-150 hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={handleSubmit}
                disabled={!canSubmit()}
                title={submitDisabledReason() || undefined}
                aria-describedby={
                  submitDisabledReason() ? "employee-submit-reason" : undefined
                }
              >
                {submitting()
                  ? editing()
                    ? "Saving..."
                    : "Deploying..."
                  : editing()
                    ? "Save changes"
                    : "Deploy employee"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const PolicyReviewPanel: Component<{
  summary: EmployeePolicyReviewSummary;
}> = (props) => {
  const groups = () => [
    { title: "Runtime policy", lines: props.summary.runtimePolicy },
    { title: "Tool access", lines: props.summary.toolAccess },
    { title: "Typed tool details", lines: props.summary.toolRefDetails },
    { title: "Approval rules", lines: props.summary.approvalRules },
  ];

  return (
    <section
      class="mt-4 border-t border-border pt-3"
      aria-labelledby="employee-policy-review-title"
    >
      <h3
        id="employee-policy-review-title"
        class="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70"
      >
        Deployment review
      </h3>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <For each={groups()}>
          {(group) => (
            <div class="rounded-md border border-border bg-card p-3">
              <div class="mb-1.5 text-[12px] font-semibold text-foreground">
                {group.title}
              </div>
              <ul class="m-0 list-none space-y-1 p-0">
                <For each={group.lines}>
                  {(line) => (
                    <li class="text-[11.5px] leading-snug text-muted-foreground">
                      {line}
                    </li>
                  )}
                </For>
              </ul>
            </div>
          )}
        </For>
      </div>
    </section>
  );
};

const NumField: Component<{
  label: string;
  value: number;
  onInput: (n: number) => void;
  disabled?: boolean;
}> = (props) => (
  <label class="block">
    <span class="block text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70 mb-1.5">
      {props.label}
    </span>
    <input
      type="number"
      min="0"
      class="w-full py-2 px-3 bg-card text-foreground border border-border rounded text-sm font-mono focus:outline-none focus:border-primary"
      value={props.value}
      onInput={(e) => {
        const raw = e.currentTarget.value;
        if (raw === "") return;
        const v = Number(raw);
        if (Number.isFinite(v) && v >= 0) props.onInput(v);
      }}
      disabled={props.disabled}
    />
  </label>
);
