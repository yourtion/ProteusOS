/** Candidate from the sealed development observation; registration does not promote it. */
export const RELIABILITY_BASELINE = Object.freeze({
  version: "routing-reliability-baseline-v1",
  model: "GLM-5.3-Flash",
  conditionId: "v2-t1024-d0",
  snapshotDigest: "5b481483aeffbf265e1262cc8267b7d62222d4d0818411a8995c0c9996e7c142",
  endpoint: "https://open.bigmodel.cn/api/anthropic",
  output: 1024,
  runMs: 90000,
  decisionMs: 85000,
} as const);
