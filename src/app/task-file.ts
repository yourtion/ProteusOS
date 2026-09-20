import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

/**
 * task.yaml 最小 schema（Q9 确认）：goal / inputs / constraints.budget / acceptance。
 * 相对路径一律相对 task 文件所在目录解析。
 */
const BudgetSchema = z.object({
  maxAttempts: z.number().int().positive().optional(),
  maxWallClockSeconds: z.number().int().positive().optional(),
});

export const TaskFileSchema = z.object({
  goal: z.string().min(1),
  inputs: z.array(z.string().min(1)).min(1),
  constraints: z
    .object({
      budget: BudgetSchema.optional(),
    })
    .optional(),
  acceptance: z.object({
    outputSchema: z.string().min(1),
    /** 指向 G0 的 acceptance-evaluator 槽位绑定的 artifact（stats-acceptance） */
    verifier: z.string().min(1),
  }),
});

export type TaskFile = z.infer<typeof TaskFileSchema>;

export interface LoadedTaskFile {
  file: TaskFile;
  budget: { maxAttempts: number; maxWallClockSeconds: number };
  baseDir: string;
}

export function loadTaskFile(path: string): LoadedTaskFile {
  const raw = readFileSync(path, "utf8");
  const file = TaskFileSchema.parse(parse(raw) as unknown);
  return {
    file,
    budget: {
      maxAttempts: file.constraints?.budget?.maxAttempts ?? 3,
      maxWallClockSeconds: file.constraints?.budget?.maxWallClockSeconds ?? 300,
    },
    baseDir: dirname(resolve(path)),
  };
}

export function resolveFrom(baseDir: string, p: string): string {
  return isAbsolute(p) ? p : join(baseDir, p);
}
