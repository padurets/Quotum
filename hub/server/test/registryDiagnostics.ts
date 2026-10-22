/** Parse numeric helper milestones only; never retain a transcript or key material. */
export function registryStages(stderr: unknown) {
  if (!Buffer.isBuffer(stderr) || stderr.length > 4096) return [];
  const stages: {stage: number; ms: number}[] = [];
  for (const line of stderr.toString('utf8').split(/\r?\n/)) {
    const match = /^QKS1 ([1-9]|10|11) (0|[1-9][0-9]{0,5})$/.exec(line);
    if (match && stages.length < 16) stages.push({stage: Number(match[1]), ms: Number(match[2])});
  }
  return stages;
}
