// actions.ts — the per-box action danger table (TUI-D10).
//
// Danger classification lives HERE (and is ALSO enforced server-side, TUI-D10).
// A DANGEROUS action opens a modal that requires typing the box name; the typed
// name feeds the `{confirm}` body. A non-destructive action (check) runs
// immediately with no modal. The keys P/M/R/T select per-box actions; a
// fleet-level reconcile is a separate confirm ("fleet").

export type ActionKind = "config-push" | "rotate-key" | "rename" | "check" | "reconcile";

export interface ActionSpec {
  kind: ActionKind;
  /** the key that triggers it (upper-case). */
  key: string;
  /** human label for the modal / footer. */
  label: string;
  /** true ⇒ destructive: opens a typed-name confirm modal (TUI-D10). */
  danger: boolean;
  /** requires the admin scope (all mutations do; check does too). */
  admin: boolean;
  /** rename ALSO needs a target box name (the `to`). */
  needsTarget?: boolean;
  /** extra modal note (push: "single box, no canary gate"). */
  note?: string;
}

/** The per-box action table, keyed by the trigger char (upper-case). */
export const PER_BOX_ACTIONS: Record<string, ActionSpec> = {
  P: {
    kind: "config-push",
    key: "P",
    label: "config-push",
    danger: true,
    admin: true,
    note: "single box, no canary gate",
  },
  M: { kind: "rotate-key", key: "M", label: "rotate-key", danger: true, admin: true },
  R: { kind: "rename", key: "R", label: "rename", danger: true, admin: true, needsTarget: true },
  T: { kind: "check", key: "T", label: "check", danger: false, admin: true },
};

/** The fleet-level reconcile action (confirm = "fleet"). */
export const RECONCILE_ACTION: ActionSpec = {
  kind: "reconcile",
  key: "C",
  label: "reconcile",
  danger: true,
  admin: true,
};

/** Look up a per-box action by its trigger key (case-insensitive). */
export function actionForKey(key: string): ActionSpec | undefined {
  return PER_BOX_ACTIONS[key.toUpperCase()];
}

/** The confirm string a dangerous action expects (box name, or "fleet"). */
export function confirmValue(spec: ActionSpec, box: string): string {
  return spec.kind === "reconcile" ? "fleet" : box;
}

/** true iff the modal must collect a target box name (rename). */
export function needsTarget(spec: ActionSpec): boolean {
  return spec.needsTarget === true;
}
