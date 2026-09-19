// Cheap term extraction for the trending cloud and the co-occurrence graph.
// Runs on every judged post, so it stays regex-only: no Jev call, no tokenizer.

const STOP = new Set(`a about above after again against all also am an and any are aren't as at be because been before being below
between both but by can can't could couldn't did didn't do does doesn't doing don't down during each few for from further get
got had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd
i'll i'm i've if in into is isn't it it's its itself just let's like lol me more most much my myself no nor not now of off
on once one only or other our ours ourselves out over own really same she she'd she'll she's should shouldn't so some still
such than that that's the their theirs them themselves then there there's these they they'd they'll they're they've this
those through to too under until up us very was wasn't we we'd we'll we're we've were weren't what what's when when's where
where's which while who who's whom why why's will with won't would wouldn't you you'd you'll you're you've your yours yourself
yourselves yeah yes yep nope ok okay im dont cant wont thats ive youre theyre isnt didnt doesnt gonna wanna gotta ur u r
people thing things something anything nothing everything someone anyone everyone way time day today going make made know
think see look want need come back even still also well much many every never always going right good great new old
first last long little big`.split(/\s+/));

const TOKEN = /#?[a-z][a-z0-9'’-]{2,}/g;

export function extractTerms(text: string, cap = 12): string[] {
  const clean = text.toLowerCase().replace(/https?:\/\/\S+|\S+\.(com|net|org|io|ai|app|co)\b\S*/g, " ");
  const seen = new Set<string>();
  for (const raw of clean.match(TOKEN) ?? []) {
    const t = raw.replace(/[’']s$/, "").replace(/[-'’]+$/, "");
    if (t.length < 3 || STOP.has(t) || STOP.has(t.replace(/^#/, ""))) continue;
    seen.add(t);
    if (seen.size >= cap) break;
  }
  return [...seen];
}
