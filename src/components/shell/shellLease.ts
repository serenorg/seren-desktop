// ABOUTME: Pure predicate selection for a shell "Approve for this task" lease:
// ABOUTME: single blocked program by default, or the full derived coding toolchain when opted in.

import type {
  CommandRule,
  LeasePredicates,
} from "@/services/tool-authorization";

/**
 * The command-rule predicates to grant when a user approves a shell command for
 * the whole task. The default is the single blocked `program` — the conservative
 * subset of intent, matching the gate's leading-program key. When the user opts
 * in (`coverToolchain`) and the program is part of the derived coding toolchain
 * (`toolchainRules`, sourced once from the host so the renderer never hard-codes
 * it), the lease instead covers the whole toolchain so a coding task does not
 * re-escalate on every distinct program. An off toggle, or a program outside the
 * toolchain, always yields the single-program rule — the default is never
 * silently broadened.
 */
export function shellLeasePredicates(
  program: string,
  coverToolchain: boolean,
  toolchainRules: CommandRule[],
): LeasePredicates {
  const inToolchain = toolchainRules.some((rule) => rule.program === program);
  if (coverToolchain && inToolchain) {
    return { commandRules: toolchainRules };
  }
  return { commandRules: [{ program }] };
}
