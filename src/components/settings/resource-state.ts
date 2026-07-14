// ABOUTME: Converts settings-panel resource failures into renderable state.
// ABOUTME: Prevents recoverable API failures from reaching the panel boundary.

export interface ResourceState<T> {
  data: T;
  failed: boolean;
}

export function loadedResource<T>(data: T): ResourceState<T> {
  return { data, failed: false };
}

export async function loadResourceState<T>(
  load: () => Promise<T>,
  fallback: T,
): Promise<ResourceState<T>> {
  try {
    return loadedResource(await load());
  } catch {
    return { data: fallback, failed: true };
  }
}
