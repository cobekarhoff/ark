/**
 * The one form of an AC id in run state, events, plan.yml and results: `<ticket id>/AC<k>`.
 * `AC<k>` is local to its ticket and gets `ticketId`; the old `<ticket id>-AC<k>` is the same AC.
 * Any other text passes through unchanged.
 */
export function canonicalCriterion(id: string, ticketId?: string): string {
  if (/^AC\d+$/.test(id)) return ticketId ? `${ticketId}/${id}` : id;
  return id.replace(/^(.+)-(AC\d+)$/, "$1/$2");
}

/** True for a test case id `<KEY>-T<n>`. */
export const isCaseId = (id: string): boolean => /^[A-Z][A-Z0-9]*-T\d+$/.test(id);
