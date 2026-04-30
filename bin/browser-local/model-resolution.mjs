// ABOUTME: Pure helpers for Claude Code session model resolution (#1635).
// ABOUTME: Separated so the "message.model is ground truth" rule is unit-testable.

/**
 * Resolve an incoming Anthropic message.model value against the session's
 * known model records. Exact match wins; otherwise a fuzzy tier-matched
 * fallback is used so "opus"/"sonnet"/"haiku" still pick sensible entries
 * when the CLI ships a new display name before we've updated the catalog.
 * Returns null when no record matches and no reasonable tier fallback exists.
 */
export function inferCurrentModelId(currentModel, records) {
  if (!currentModel || !Array.isArray(records) || records.length === 0) {
    return records?.[0]?.modelId ?? null;
  }

  const exact = records.find((record) => record.modelId === currentModel);
  if (exact) return exact.modelId;

  const lower = String(currentModel).toLowerCase();
  if (lower.includes("opus")) {
    return (
      records.find((record) => record.modelId === "default")?.modelId ??
      records.find((record) => record.modelId.startsWith("opus"))?.modelId ??
      records.find((record) => record.modelId.toLowerCase().includes("opus"))
        ?.modelId ??
      records[0]?.modelId ??
      null
    );
  }
  if (lower.includes("sonnet")) {
    return (
      records.find((record) =>
        record.modelId.toLowerCase().includes("sonnet"),
      )?.modelId ??
      records[0]?.modelId ??
      null
    );
  }
  if (lower.includes("haiku")) {
    return (
      records.find((record) =>
        record.modelId.toLowerCase().includes("haiku"),
      )?.modelId ??
      records[0]?.modelId ??
      null
    );
  }
  return records[0]?.modelId ?? null;
}

/**
 * Given the session's current model id and an incoming assistant message's
 * model field, decide what the next `session.currentModelId` should be.
 * Returns null when the session should keep its current value (no usable
 * message.model). The caller emits a session-status event only if the
 * returned value differs from the previous one.
 *
 * This encodes the #1635 rule: message.model from Anthropic is the ground
 * truth for what the CLI is actually running. The picker is a request,
 * not the source of truth — if a set_model control request was ignored or
 * fell back upstream, the UI must reflect that.
 */
export function chooseUpdatedModelId(
  previousModelId,
  incomingMessageModel,
  availableModelRecords,
) {
  if (typeof incomingMessageModel !== "string" || incomingMessageModel.length === 0) {
    return null;
  }
  // Reject sentinel-bracketed placeholders. The Claude Code CLI emits
  // synthesized assistant turns (e.g. on "Stream idle timeout - partial
  // response received") with `message.model` set to internal placeholders
  // like `<synthetic>`. Real Anthropic model ids never use angle brackets,
  // so accepting these as ground truth poisons `session.currentModelId`
  // and propagates to the next `--model` spawn arg, which the CLI hard-
  // rejects with "issue with the selected model (<synthetic>)".
  if (/^<.+>$/.test(incomingMessageModel)) {
    return null;
  }
  // Preserve the `[1m]` suffix when the session is on a 1M-tier variant.
  // Anthropic echoes the bare resolved id (e.g. `claude-opus-4-7-20251201`)
  // in `message.model`; without this guard the next assistant turn would
  // overwrite `session.currentModelId` with the bare id, the next spawn
  // would drop the `[1m]` suffix from `--model`, and the API would silently
  // serve the 200K tier on subsequent turns. The bare-id `incomingMessageModel`
  // remains ground truth for the underlying model identity — we only
  // re-attach the tier marker the CLI was asked to keep. See #1763.
  if (
    typeof previousModelId === "string" &&
    /\[1m\]$/i.test(previousModelId)
  ) {
    const previousBare = previousModelId
      .replace(/\[1m\]$/i, "")
      .replace(/-\d{8}$/, "");
    const incomingBare = incomingMessageModel.replace(/-\d{8}$/, "");
    if (
      previousBare.length > 0 &&
      (previousBare === incomingBare || incomingBare.startsWith(previousBare))
    ) {
      return previousModelId;
    }
  }
  const records = Array.isArray(availableModelRecords)
    ? availableModelRecords
    : [];
  // Exact catalog match wins. Anything else (unrecognized model shipped by
  // Anthropic today, renamed id, etc.) surfaces as the raw id — the UI
  // shows what the CLI actually reported, never a silently-remapped
  // lookalike. Ground truth > prettiness (#1635).
  const exact = records.find((record) => record.modelId === incomingMessageModel);
  if (exact) return exact.modelId;
  return incomingMessageModel;
}
