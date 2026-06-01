// A tiny saved workflow, runnable with: workflow({ name: "example", args: { topic: "..." } })
// or from inside another script via workflow("example", { topic }).
//
// Fans out a few independent "angle" agents on a topic, then synthesizes their
// takes into one summary — the smallest useful map/reduce shape.
export const meta = {
  name: 'example',
  description: 'Summarize a topic from multiple angles, then synthesize.',
  phases: [{ title: 'Angles' }, { title: 'Synthesize' }],
};

const topic = (args && args.topic) || 'the benefits of provider-agnostic AI tooling';
const ANGLES = ['a skeptic', 'an enthusiast', 'a pragmatic engineer'];

phase('Angles');
const takes = await parallel(
  ANGLES.map(angle => () =>
    agent(`In 2-3 sentences, give ${angle}'s view on: ${topic}`, { label: angle, phase: 'Angles' })
  )
);

phase('Synthesize');
const summary = await agent(
  `Synthesize these perspectives on "${topic}" into one balanced paragraph:\n\n` +
    takes.filter(Boolean).map((t, i) => `[${ANGLES[i]}] ${t}`).join('\n\n'),
  { label: 'synthesis', phase: 'Synthesize' }
);

return { topic, takes, summary };
