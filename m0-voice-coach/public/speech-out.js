// Spoken-output helpers (pure, unit-tested). The browser TTS layer
// (speechSynthesis) behaves differently per OS/browser — most notably macOS
// Safari: voices arrive late, long utterances stall ~15s in, quality varies.
// Strategy used by speakText(): wait for voices, prefer local English ones,
// speak sentence-sized chunks (no giant single utterance), and run a resume
// watchdog. UMD: browser global via <script> tag, require()-able in Node.

// Split text into speakable chunks at sentence boundaries, each ≤ maxLen.
// A single over-long sentence is force-split at word boundaries.
function splitSpokenText(text, maxLen) {
  const max = maxLen || 220;
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [clean];
  const chunks = [];
  let current = '';
  const pushChunk = (s) => {
    const t = s.trim();
    if (t) chunks.push(t);
  };
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if ((current + ' ' + s).trim().length <= max) {
      current = (current + ' ' + s).trim();
    } else {
      pushChunk(current);
      if (s.length <= max) {
        current = s;
      } else {
        // Force-split a monster sentence on words.
        const words = s.split(' ');
        current = '';
        for (const w of words) {
          if ((current + ' ' + w).trim().length <= max) {
            current = (current + ' ' + w).trim();
          } else {
            pushChunk(current);
            current = w;
          }
        }
      }
    }
  }
  pushChunk(current);
  return chunks;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { splitSpokenText };
}
