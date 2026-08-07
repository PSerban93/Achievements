"use strict";

const PROCESS_CONFIG_MATCH = Object.freeze({
  NONE: "none",
  EXECUTABLE_ARGUMENTS_MISMATCH: "executable-arguments-mismatch",
  EXECUTABLE_COMMAND_LINE_UNAVAILABLE:
    "executable-command-line-unavailable",
  GENERIC_EXECUTABLE: "generic-executable",
  EXACT_ARGUMENTS: "exact-arguments",
  MANUAL: "manual",
});

const PROCESS_CONFIG_MATCH_RANK = Object.freeze({
  [PROCESS_CONFIG_MATCH.NONE]: 0,
  [PROCESS_CONFIG_MATCH.EXECUTABLE_ARGUMENTS_MISMATCH]: 1,
  [PROCESS_CONFIG_MATCH.EXECUTABLE_COMMAND_LINE_UNAVAILABLE]: 1,
  [PROCESS_CONFIG_MATCH.GENERIC_EXECUTABLE]: 2,
  [PROCESS_CONFIG_MATCH.EXACT_ARGUMENTS]: 3,
  [PROCESS_CONFIG_MATCH.MANUAL]: 4,
});

function normalizeStringList(values) {
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
}

function classifyProcessConfigMatch({
  processName = "",
  executableNames = [],
  argumentTokens = [],
  commandLine = "",
  mappedConfigName = null,
  configName = "",
} = {}) {
  const normalizedProcessName = String(processName || "")
    .trim()
    .toLowerCase();
  const normalizedExecutableNames = normalizeStringList(executableNames);
  if (
    !normalizedProcessName ||
    !normalizedExecutableNames.includes(normalizedProcessName)
  ) {
    return PROCESS_CONFIG_MATCH.NONE;
  }

  if (mappedConfigName !== null && mappedConfigName !== undefined) {
    return String(mappedConfigName) === String(configName)
      ? PROCESS_CONFIG_MATCH.MANUAL
      : PROCESS_CONFIG_MATCH.NONE;
  }

  const normalizedArgumentTokens = normalizeStringList(argumentTokens);
  if (!normalizedArgumentTokens.length) {
    return PROCESS_CONFIG_MATCH.GENERIC_EXECUTABLE;
  }

  const normalizedCommandLine = String(commandLine || "")
    .trim()
    .toLowerCase();
  if (!normalizedCommandLine) {
    return PROCESS_CONFIG_MATCH.EXECUTABLE_COMMAND_LINE_UNAVAILABLE;
  }
  if (
    normalizedArgumentTokens.every((token) =>
      normalizedCommandLine.includes(token),
    )
  ) {
    return PROCESS_CONFIG_MATCH.EXACT_ARGUMENTS;
  }
  return PROCESS_CONFIG_MATCH.EXECUTABLE_ARGUMENTS_MISMATCH;
}

function getProcessConfigMatchRank(matchKind) {
  return Number(PROCESS_CONFIG_MATCH_RANK[matchKind]) || 0;
}

function selectBestProcessConfigCandidate(candidates = []) {
  const ranked = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => ({
      ...candidate,
      matchRank: getProcessConfigMatchRank(candidate?.matchKind),
    }))
    .filter((candidate) => candidate.matchRank > 0)
    .sort((a, b) => {
      if (a.matchRank !== b.matchRank) return b.matchRank - a.matchRank;
      return String(a.configName || "").localeCompare(
        String(b.configName || ""),
      );
    });
  if (!ranked.length) {
    return {
      selected: null,
      ambiguous: false,
      bestCandidates: [],
      candidates: [],
      matchRank: 0,
    };
  }

  const matchRank = ranked[0].matchRank;
  const bestCandidates = ranked.filter(
    (candidate) => candidate.matchRank === matchRank,
  );
  return {
    selected: bestCandidates.length === 1 ? bestCandidates[0] : null,
    ambiguous: bestCandidates.length > 1,
    bestCandidates,
    candidates: ranked,
    matchRank,
  };
}

module.exports = {
  PROCESS_CONFIG_MATCH,
  classifyProcessConfigMatch,
  getProcessConfigMatchRank,
  selectBestProcessConfigCandidate,
};
