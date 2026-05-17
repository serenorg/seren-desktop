// ABOUTME: Computes file-level patches between employee bundles.
// ABOUTME: Keeps managed-file edits on the narrow /managed/files API.

import type {
  AgentAssetFile,
  AgentBundle,
  AgentBundlePatch,
  AgentInstructionFile,
} from "@/api/seren-agent";

function instructionKey(file: AgentInstructionFile): string {
  return `${file.kind}\0${file.path}`;
}

function sameInstruction(
  left: AgentInstructionFile,
  right: AgentInstructionFile,
): boolean {
  return (
    left.kind === right.kind &&
    left.path === right.path &&
    left.content === right.content
  );
}

function sameAsset(left: AgentAssetFile, right: AgentAssetFile): boolean {
  return (
    left.path === right.path &&
    left.content_base64 === right.content_base64 &&
    left.content_type === right.content_type &&
    left.purpose === right.purpose &&
    left.sha256 === right.sha256
  );
}

export function buildEmployeeFilesPatch(
  current: AgentBundle | null | undefined,
  next: AgentBundle,
): AgentBundlePatch | null {
  const currentInstructions = current?.instructions ?? [];
  const nextInstructions = next.instructions ?? [];
  const currentAssets = current?.assets ?? [];
  const nextAssets = next.assets ?? [];

  const currentInstructionMap = new Map(
    currentInstructions.map((file) => [instructionKey(file), file]),
  );
  const nextInstructionMap = new Map(
    nextInstructions.map((file) => [instructionKey(file), file]),
  );
  const currentAssetMap = new Map(
    currentAssets.map((asset) => [asset.path, asset]),
  );
  const nextAssetMap = new Map(nextAssets.map((asset) => [asset.path, asset]));

  const remove_instructions = currentInstructions
    .filter((file) => !nextInstructionMap.has(instructionKey(file)))
    .map((file) => ({ kind: file.kind, path: file.path }));
  const upsert_instructions = nextInstructions.filter((file) => {
    const previous = currentInstructionMap.get(instructionKey(file));
    return !previous || !sameInstruction(previous, file);
  });
  const remove_assets = currentAssets
    .filter((asset) => !nextAssetMap.has(asset.path))
    .map((asset) => asset.path);
  const upsert_assets = nextAssets.filter((asset) => {
    const previous = currentAssetMap.get(asset.path);
    return !previous || !sameAsset(previous, asset);
  });

  if (
    remove_instructions.length === 0 &&
    upsert_instructions.length === 0 &&
    remove_assets.length === 0 &&
    upsert_assets.length === 0
  ) {
    return null;
  }

  return {
    ...(remove_instructions.length > 0 ? { remove_instructions } : {}),
    ...(upsert_instructions.length > 0 ? { upsert_instructions } : {}),
    ...(remove_assets.length > 0 ? { remove_assets } : {}),
    ...(upsert_assets.length > 0 ? { upsert_assets } : {}),
  };
}
