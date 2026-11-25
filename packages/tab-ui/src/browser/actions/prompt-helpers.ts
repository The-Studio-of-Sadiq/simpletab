import { t } from "../i18n";
import type { ActionContext } from "./action";

/**
 * Palette prompts shared by the step-d actions. None of them cancels on bad input: a number
 * prompt asks again with the reason, and only Escape (undefined) cancels.
 */

export interface NumberRule {
  /** Whole numbers only. */
  integer?: boolean;
  min?: number;
  max?: number;
}

function numberProblem(raw: string, rule: NumberRule): string | undefined {
  const value = Number(raw.trim());
  if (raw.trim().length === 0 || !Number.isFinite(value)) {
    return t("action.prompt.notANumber");
  }
  if (rule.integer === true && !Number.isInteger(value)) {
    return t("action.prompt.wholeNumber");
  }
  if (rule.min !== undefined && value < rule.min) {
    return t("action.prompt.atLeast", { min: rule.min });
  }
  if (rule.max !== undefined && value > rule.max) {
    return t("action.prompt.atMost", { max: rule.max });
  }
  return undefined;
}

/** Asks for a number, asking again (with the reason) until it gets a valid one. */
export async function inputNumber(
  ctx: ActionContext,
  label: string,
  value: number | undefined,
  rule: NumberRule = {},
): Promise<number | undefined> {
  let current = value === undefined ? "" : String(value);
  let prompt = label;
  for (;;) {
    const raw = await ctx.prompts.input(prompt, { value: current });
    if (raw === undefined) return undefined;
    const problem = numberProblem(raw, rule);
    if (problem === undefined) return Number(raw.trim());
    current = raw;
    prompt = `${label}: ${problem}`;
  }
}

/** Like `inputNumber`, but an empty answer is allowed and gives `null`. */
export async function inputOptionalNumber(
  ctx: ActionContext,
  label: string,
  value: number | undefined,
  rule: NumberRule = {},
): Promise<number | null | undefined> {
  let current = value === undefined ? "" : String(value);
  let prompt = label;
  for (;;) {
    const raw = await ctx.prompts.input(prompt, { value: current, optional: true });
    if (raw === undefined) return undefined;
    if (raw.trim().length === 0) return null;
    const problem = numberProblem(raw, rule);
    if (problem === undefined) return Number(raw.trim());
    current = raw;
    prompt = `${label}: ${problem}`;
  }
}

/** Asks for text that may not be blank, asking again until it gets some. */
export async function inputRequired(
  ctx: ActionContext,
  label: string,
  value: string | undefined,
  options: { password?: boolean } = {},
): Promise<string | undefined> {
  let prompt = label;
  for (;;) {
    const raw = await ctx.prompts.input(prompt, { value, password: options.password });
    if (raw === undefined) return undefined;
    if (raw.trim().length > 0) return raw;
    prompt = t("action.prompt.requiredField", { field: label });
  }
}

/** A yes/no choice with the current value first; undefined only on Escape. */
export async function pickYesNo(
  ctx: ActionContext,
  label: string,
  current: boolean,
): Promise<boolean | undefined> {
  const yes = { label: t("common.yes"), value: true };
  const no = { label: t("common.no"), value: false };
  return ctx.prompts.pick(current ? [yes, no] : [no, yes], label);
}

/**
 * Edits a set of ids one toggle at a time, starting from `initial`: each pick adds or removes
 * one item, and "Done choosing" keeps the set. Undefined on Escape.
 */
export async function toggleMany(
  ctx: ActionContext,
  candidates: ReadonlyArray<{ id: string; name: string }>,
  placeholder: string,
  initial: readonly string[] = [],
): Promise<string[] | undefined> {
  const known = new Set(candidates.map((item) => item.id));
  let chosen = initial.filter((id) => known.has(id));
  for (;;) {
    const next = await ctx.prompts.pick(
      [
        { label: t("action.prompt.doneChoosing"), description: t("action.prompt.chosenCount", { count: chosen.length }), value: "" },
        ...candidates.map((item) => ({
          label: item.name,
          description: chosen.includes(item.id) ? t("action.prompt.chosen") : undefined,
          value: item.id,
        })),
      ],
      placeholder,
    );
    if (next === undefined) return undefined;
    if (next.length === 0) return chosen;
    chosen = chosen.includes(next) ? chosen.filter((id) => id !== next) : [...chosen, next];
  }
}
