module.exports = {
  v: '1.102.2', date: 'June 11, 2026', tag: 'fix',
  changes: [
    { t: 'fix', d: '**Marketing: AI generation schemas fully pass Claude validation.** The v1.102.1 fix handled minItems but the validator also rejects maxItems on arrays — every array length constraint is now stripped from the digest, citability, and content-plan schemas (counts live in the prompts). Digest generation works end to end.' },
  ],
};
