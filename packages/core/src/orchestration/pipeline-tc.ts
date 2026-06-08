import { TC } from "../tc/tc-types";
import { tcAdd, tcMul, tcWeightedSum } from "../tc/tc-semiring";

export type PipelineStage = "BUILD" | "TEST" | "INDEX" | "GIT";

export const STAGE_WEIGHTS: Record<PipelineStage, number> = {
  BUILD: 0.35,
  TEST: 0.30,
  INDEX: 0.20,
  GIT: 0.15,
};

export interface TCStageResult {
  stage: PipelineStage;
  tc: TC;
  details?: string;
}

export function tcComputePipelineTC(stages: TCStageResult[]): TC {
  if (stages.length === 0) return TC.NONE;
  const weighted = tcWeightedSum(
    stages.map(s => ({ tc: s.tc, weight: STAGE_WEIGHTS[s.stage] }))
  );
  let chain = TC.NONE;
  for (const s of stages) {
    chain = tcMul(chain, s.tc);
    chain = tcAdd(chain, s.tc);
  }
  return tcAdd(weighted, chain);
}

export function tcBuildPipelineSummary(stages: TCStageResult[]): string {
  const chain = stages.map(s => `${s.stage}:${TC[s.tc]}`).join(" -> ");
  const finalTC = tcComputePipelineTC(stages);
  return `[Pipeline TC] ${chain} => ${TC[finalTC]}`;
}
