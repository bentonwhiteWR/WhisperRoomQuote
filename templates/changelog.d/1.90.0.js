module.exports = {
  v: '1.90.0', date: 'June 10, 2026', tag: 'feature',
  changes: [
    { t: 'ui', d: '**Booth Builder is customer-clean.** The page navbar is gone (a plain WhisperRoom wordmark remains) so prospects can&apos;t wander into the internal dashboards, and the Booth Builder link is out of the internal nav for now — reps share the /booth-builder URL directly.' },
    { t: 'ui', d: '**The booth finally looks like a WhisperRoom.** Walls, seam seals, door leaf and roof cap now render in the product&apos;s near-black charcoal carpet (sampled from the product renders) in both the top-down and walk-around views, with door hardware drawn light so it reads on the dark leaf.' },
    { t: 'add', d: '**&quot;Make it yours&quot; expanded.** New toggles for the real catalog options: Quieter ventilation (Ventilation Silencing System), Studio light, Cable jack panel, Bass traps and Office desk. All of them ride the booth summary, the shareable design link and the quote request.' },
    { t: 'fix', d: '**Wide-access door moves the seam seal to the true joint.** The WA frame now draws at its real 49&Prime; width and its shrunken companion at 7/19/31/43&Prime;, so the panel boundary and the seam seal on it shift over 3&Prime; (4646/4622 types) or 9&Prime; (4040/4016 types) exactly like the built booth — in both views. The WA leaf also swings its true 32&Prime;.' },
    { t: 'ui', d: '**Choose-your-size dropdown leads with the model number** — &quot;MDL 9696 — 8&apos;×8&apos;&quot;.' },
    { t: 'ui', d: '**Dragging is forgiving now.** Wall grab targets are ~3× bigger (and extend outside the shell), every valid landing spot glows green the moment you grab a panel (invalid spots glow red), and a drop within ~48px snaps to the nearest valid wall. Works with touch — pointer events + snap targets sized for fingers.' },
  ],
};
