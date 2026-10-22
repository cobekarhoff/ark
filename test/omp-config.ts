// A project .omp/config.yml that passes `ark preflight`: Codex implements, Claude validates and reviews.
export const OMP_CONFIG = `modelRoles:
  implement: openai-codex/gpt-6.1-sol:high
  validate: anthropic/claude-sonnet-5-5:high
  review-x: anthropic/claude-opus-5-5:high
  review-s: openai-codex/gpt-6.1-sol:high
`;
