/** A test case id `<KEY>-T<n>`. It never matches an old AC id such as ARK-311-AC1. */
export const casePattern = /(?<![\w/-])[A-Z][A-Z0-9]*-T\d+\b/g;

export const caseIdsIn = (text: string): string[] => [...new Set(text.match(casePattern) ?? [])];
